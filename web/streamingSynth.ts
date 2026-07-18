/**
 * streamingSynth.ts — real-time, just-in-time block synthesis of a Song.
 *
 * The offline engine (synth.ts) renders a whole note (and the whole song) at
 * once. This module reuses the *exact same DSP math* but in STATEFUL, resumable
 * form: each active note is a voice object that emits a block of samples at a
 * time and keeps its phase / filter / delay-line state across blocks, so the
 * player can start instantly, seek instantly, and hear instrument/param/mixer
 * edits live without ever re-rendering the whole song.
 *
 * Signal flow per block (mono buses, widened to stereo by the shared FX):
 *   for each active voice -> enveloped sample s
 *     dry     += chGain * s                        (every channel, full)
 *     revBus  += chGain * reverbSend * s           (shared reverb send bus)
 *     delBus  += chGain * delaySend * s            (shared delay send bus)
 *   L/R = dry + reverb.mix*reverbWet(revBus) + pingPongWet(delBus)
 *   L/R = masterGain -> Compressor (opt) -> Limiter -> clamp
 *
 * The mixer (per-channel volume / mute / solo / sends) is read *per block* off a
 * live map, so even a long sustained note responds to a mute or fader move.
 */
import {
  type Song,
  type Note,
} from "../midiParse.ts";
import {
  type RenderOptions,
  type Voice,
  type Vibrato,
  type Reverb,
  type Delay,
  type FormantConfig,
  Compressor,
  VOWELS,
  gmVoiceFor,
} from "../synth.ts";
import { renderDrum } from "../drums.ts";

const SR = 44100;
const midiToHz = (pitch: number): number => 440 * 2 ** ((pitch - 69) / 12);

// A fixed makeup gain feeding the compressor/limiter. Streaming can't peek at
// the whole song to peak-normalize (offline's masterGain), so we use a static
// gain and let the compressor + limiter control the ceiling.
const MASTER_GAIN = 1.25;
const LIMITER: { threshold: number; ratio: number; attack: number; release: number } = {
  threshold: -1,
  ratio: 20,
  attack: 0.001,
  release: 0.05,
};

// ---- small DSP helpers (duplicated from synth.ts so the CLI stays untouched) ----
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}
function vibFactor(vib: Vibrato | undefined, k: number): number {
  if (!vib) return 1;
  return 2 ** ((vib.depth / 1200) * Math.sin((2 * Math.PI * vib.rate * k) / SR));
}
interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number; }
function bandpass(f: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f) / SR;
  const alpha = Math.sin(w0) / (2 * Math.max(q, 0.1));
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0 };
}

// ---- per-channel mixer state ----
export interface ChannelMix {
  volume: number; // 0..1 fader (separate from the patch's voiceOverride.gain)
  mute: boolean;
  solo: boolean;
  reverbSend: number; // 0..1
  delaySend: number; // 0..1
}
export function defaultChannelMix(): ChannelMix {
  return { volume: 1, mute: false, solo: false, reverbSend: 0.25, delaySend: 0 };
}

// ---- runtime voice: stateful, resumable, one per sounding note ----
interface RtVoice {
  chanKey: string; // "track:channel" for live mixer lookup
  firstOffset: number; // sample offset within its first block
  done: boolean;
  /** Write enveloped output into scratch[start..start+count); advance state. */
  render(scratch: Float32Array, start: number, count: number): void;
}

/** A pitched note played through one of the five engines, resumably. */
/** Clamp to a finite ceiling; non-finite -> 0 (keeps NaN/Inf out of feedback FX). */
function clampFinite(x: number): number {
  return Number.isFinite(x) ? (x > 16 ? 16 : x < -16 ? -16 : x) : 0;
}

/** Which engine a Voice selects (matches the constructor's branch order). */
function voiceEngine(v: Voice): "add" | "fm" | "sub" | "formant" | "ks" {
  if (v.ks) return "ks";
  if (v.formant) return "formant";
  if (v.sub) return "sub";
  if (v.fm) return "fm";
  return "add";
}

class PitchedVoice implements RtVoice {
  chanKey: string;
  firstOffset: number;
  done = false;
  private k = 0;
  private readonly n: number;
  private a: number; // attack samples (mutable: live edits)
  private r: number; // release samples
  private amp: number;
  private readonly inc0: number;
  readonly note: Note; // kept so the mixer can re-resolve this voice on a live edit
  private v: Voice;
  private readonly vib?: Vibrato;
  private readonly engine: "add" | "fm" | "sub" | "formant" | "ks";

  // --- engine state ---
  private ph = 0; // additive phase
  private pc = 0; private pm = 0; // fm carrier/modulator phase
  private phases!: Float64Array; private baseIncs!: Float64Array; // sub/formant unison
  private low = 0; private band = 0; // sub SVF
  private fx1 = [0, 0, 0]; private fx2 = [0, 0, 0]; private fy1 = [0, 0, 0]; private fy2 = [0, 0, 0]; // formant biquads
  private co: Biquad[] = []; private A!: { f: number[]; g: number[]; bw: number[] }; private B!: { f: number[]; g: number[]; bw: number[] }; private morph = false;
  private line!: Float32Array; private idx = 0; private ksB = 0; // KS
  private ksc1?: Biquad; private ksc2?: Biquad; // KS body resonators
  private kb = [0, 0, 0, 0, 0, 0, 0, 0]; // body biquad state [x1a,x2a,y1a,y2a,x1b,x2b,y1b,y2b]

  constructor(note: Note, v: Voice, vib: Vibrato | undefined, chanKey: string, firstOffset: number) {
    this.chanKey = chanKey;
    this.firstOffset = firstOffset;
    this.note = note;
    this.v = v;
    this.vib = vib;
    this.n = Math.max(Math.floor(note.dur * SR), 1);
    this.a = Math.min(Math.floor(v.attack * SR), this.n >> 1);
    this.r = Math.min(Math.floor(v.release * SR), this.n >> 1);
    let pitch = note.pitch;
    if (v.foldAbove) while (pitch > v.foldAbove) pitch -= 12;
    const freq = midiToHz(pitch);
    this.inc0 = freq / SR;
    this.amp = (note.velocity / 127) ** 1.5 * 0.25 * (v.gain ?? 1);

    if (v.ks) {
      this.engine = "ks";
      const L = Math.max(2, Math.round(SR / freq));
      this.line = new Float32Array(L);
      for (let i = 0; i < L; i++) this.line[i] = Math.random() * 2 - 1;
      this.ksB = Math.min(Math.max(v.ks.damping, 0), 1);
      if ((v.ks.body ?? 0) > 0) { this.ksc1 = bandpass(110, 2.5); this.ksc2 = bandpass(230, 3); }
    } else if (v.formant) {
      this.engine = "formant";
      this.initUnison(v.formant.voices, v.formant.detune, freq);
      const [va, vb] = v.formant.vowel.split(">");
      this.A = VOWELS[va] ?? VOWELS.a;
      this.B = VOWELS[vb ?? va] ?? this.A;
      this.morph = this.B !== this.A;
      this.co = [0, 1, 2].map((i) => bandpass(this.A.f[i], this.A.f[i] / this.A.bw[i]));
    } else if (v.sub) {
      this.engine = "sub";
      this.initUnison(v.sub.voices, v.sub.detune, freq);
    } else if (v.fm) {
      this.engine = "fm";
    } else {
      this.engine = "add";
    }
  }

  private initUnison(voices: number, detune: number, freq: number): void {
    const nv = Math.max(1, Math.floor(voices));
    this.phases = new Float64Array(nv);
    this.baseIncs = new Float64Array(nv);
    for (let vv = 0; vv < nv; vv++) {
      const spread = nv > 1 ? vv / (nv - 1) - 0.5 : 0;
      this.baseIncs[vv] = (freq * 2 ** ((spread * detune) / 1200)) / SR;
      this.phases[vv] = vv / nv;
    }
  }

  /**
   * Attack/release envelope. Smoothstep (zero slope at both ends) rather than a
   * linear ramp: a linear ramp has a slope discontinuity where it meets the
   * sustain, which clicks on note onset — the smoothstep removes it.
   */
  private env(k: number): number {
    if (this.a > 0 && k < this.a) {
      const t = k / this.a;
      return t * t * (3 - 2 * t);
    }
    if (this.r > 0 && k >= this.n - this.r) {
      const t = (this.n - 1 - k) / this.r;
      return t <= 0 ? 0 : t * t * (3 - 2 * t);
    }
    return 1;
  }

  /**
   * Live-update from an edited Voice while the note is still sounding — so
   * changing release/gain/engine-params on a held note is heard immediately
   * (an attack already past can't retro-apply; that's physical). Engine-type
   * changes only take effect on new notes (the state would mismatch).
   */
  updateVoice(v: Voice): void {
    if (voiceEngine(v) !== this.engine) return;
    this.v = v; // fm/sub/etc. params are read from this.v every block -> live
    this.a = Math.min(Math.floor(v.attack * SR), this.n >> 1);
    this.r = Math.min(Math.floor(v.release * SR), this.n >> 1);
    this.amp = (this.note.velocity / 127) ** 1.5 * 0.25 * (v.gain ?? 1);
  }

  render(scratch: Float32Array, start: number, count: number): void {
    const end = start + count;
    const amp = this.amp;
    const vib = this.vib;
    switch (this.engine) {
      case "add": {
        const harmonics = this.v.harmonics ?? [];
        for (let i = start; i < end; i++) {
          if (this.k >= this.n) { scratch[i] = 0; continue; }
          let s = Math.sin(2 * Math.PI * this.ph);
          for (const h of harmonics) s += h.amp * Math.sin(2 * Math.PI * h.multiple * this.ph);
          scratch[i] = s * amp * this.env(this.k);
          this.ph += this.inc0 * vibFactor(vib, this.k);
          this.k++;
        }
        break;
      }
      case "fm": {
        const fm = this.v.fm!;
        const decaySamples = Math.max(fm.decay * SR, 1);
        for (let i = start; i < end; i++) {
          if (this.k >= this.n) { scratch[i] = 0; continue; }
          const envf = fm.sustain + (1 - fm.sustain) * Math.exp(-this.k / decaySamples);
          const index = fm.index * envf;
          scratch[i] = Math.sin(2 * Math.PI * this.pc + index * Math.sin(2 * Math.PI * this.pm)) * amp * this.env(this.k);
          const inc = this.inc0 * vibFactor(vib, this.k);
          this.pc += inc;
          this.pm += inc * fm.ratio;
          this.k++;
        }
        break;
      }
      case "sub": {
        const sub = this.v.sub!;
        const nv = this.phases.length;
        const square = sub.wave === "square";
        const drive = sub.drive ?? 1;
        const envDecaySamples = Math.max(sub.envDecay * SR, 1);
        const q1 = Math.max(2 * (1 - sub.resonance), 0.05);
        for (let i = start; i < end; i++) {
          if (this.k >= this.n) { scratch[i] = 0; continue; }
          const vf = vibFactor(vib, this.k);
          let s = 0;
          for (let vv = 0; vv < nv; vv++) {
            const dt = this.baseIncs[vv] * vf;
            let ph = this.phases[vv];
            let val: number;
            if (square) {
              val = ph < 0.5 ? 1 : -1;
              val += polyBlep(ph, dt) - polyBlep((ph + 0.5) % 1, dt);
            } else {
              val = 2 * ph - 1 - polyBlep(ph, dt);
            }
            s += val;
            ph += dt;
            if (ph >= 1) ph -= 1;
            this.phases[vv] = ph;
          }
          s /= nv;
          if (drive > 1) { const d = s * drive + 0.2; const c = d <= -1 ? -1 : d >= 1 ? 1 : 1.5 * d - 0.5 * d * d * d; s = c - 0.16; } // cubic soft-clip overdrive, pre-filter
          let fc = sub.cutoff + sub.envAmount * Math.exp(-this.k / envDecaySamples);
          if (fc > SR / 6) fc = SR / 6;
          if (fc < 20) fc = 20;
          const f = 2 * Math.sin((Math.PI * fc) / SR);
          this.low += f * this.band;
          const high = s - this.low - q1 * this.band;
          this.band += f * high;
          // a hot (distorted) signal at high cutoff+resonance can ring the SVF up
          // to Inf; reset it so the voice recovers instead of going NaN forever
          if (!Number.isFinite(this.low) || !Number.isFinite(this.band)) { this.low = 0; this.band = 0; }
          scratch[i] = this.low * amp * this.env(this.k);
          this.k++;
        }
        break;
      }
      case "formant": {
        const cfg = this.v.formant as FormantConfig;
        const nv = this.phases.length;
        const A = this.A, B = this.B, morph = this.morph;
        for (let i = start; i < end; i++) {
          if (this.k >= this.n) { scratch[i] = 0; continue; }
          const vf = vibFactor(vib, this.k);
          let s = 0;
          for (let vv = 0; vv < nv; vv++) {
            const dt = this.baseIncs[vv] * vf;
            let ph = this.phases[vv];
            s += 2 * ph - 1 - polyBlep(ph, dt);
            ph += dt;
            if (ph >= 1) ph -= 1;
            this.phases[vv] = ph;
          }
          s /= nv;
          const t = morph ? this.k / this.n : 0;
          let out = 0;
          for (let j = 0; j < 3; j++) {
            const c = morph
              ? bandpass(A.f[j] + (B.f[j] - A.f[j]) * t, (A.f[j] + (B.f[j] - A.f[j]) * t) / A.bw[j])
              : this.co[j];
            const y = c.b0 * s + c.b1 * this.fx1[j] + c.b2 * this.fx2[j] - c.a1 * this.fy1[j] - c.a2 * this.fy2[j];
            this.fx2[j] = this.fx1[j]; this.fx1[j] = s;
            this.fy2[j] = this.fy1[j]; this.fy1[j] = y;
            const g = morph ? A.g[j] + (B.g[j] - A.g[j]) * t : A.g[j];
            out += g * y;
          }
          scratch[i] = out * amp * this.env(this.k);
          this.k++;
        }
        void cfg;
        break;
      }
      case "ks": {
        const ks = this.v.ks!;
        const L = this.line.length;
        const b = this.ksB;
        for (let i = start; i < end; i++) {
          if (this.k >= this.n) { scratch[i] = 0; continue; }
          const cur = this.line[this.idx];
          const nxt = this.line[(this.idx + 1) % L];
          let out = cur;
          if (this.ksc1) { // body resonance (guitar air/wood modes)
            const kb = this.kb, c1 = this.ksc1, c2 = this.ksc2!, body = ks.body!;
            const ya = c1.b0 * cur + c1.b1 * kb[0] + c1.b2 * kb[1] - c1.a1 * kb[2] - c1.a2 * kb[3];
            kb[1] = kb[0]; kb[0] = cur; kb[3] = kb[2]; kb[2] = ya;
            const yb = c2.b0 * cur + c2.b1 * kb[4] + c2.b2 * kb[5] - c2.a1 * kb[6] - c2.a2 * kb[7];
            kb[5] = kb[4]; kb[4] = cur; kb[7] = kb[6]; kb[6] = yb;
            out = cur + body * (ya + yb);
          }
          scratch[i] = out * amp * this.env(this.k);
          this.line[this.idx] = (cur * (1 - b) + nxt * b) * ks.decay;
          this.idx = this.idx + 1 === L ? 0 : this.idx + 1;
          this.k++;
        }
        break;
      }
    }
    if (this.k >= this.n) this.done = true;
  }
}

/**
 * Render a single audition note (mono) with a given Voice, through the exact same
 * stateful PitchedVoice DSP the streaming player uses. For the on-screen piano /
 * live MIDI: build the note, render it in blocks, apply master gain + a limiter.
 */
export function renderAudition(
  voice: Voice,
  pitch: number,
  velocity: number,
  durSec: number,
  vibrato?: Vibrato,
): Float32Array {
  const note: Note = { start: 0, dur: durSec, pitch, velocity, channel: 0, track: 0 };
  const v = new PitchedVoice(note, voice, vibrato, "audition", 0);
  const n = Math.ceil((durSec + 0.05) * SR);
  const out = new Float32Array(n);
  const scratch = new Float32Array(4096);
  let pos = 0;
  while (pos < n) {
    const c = Math.min(4096, n - pos);
    v.render(scratch, 0, c);
    for (let i = 0; i < c; i++) out[pos + i] = scratch[i] * MASTER_GAIN;
    pos += c;
    if (v.done) break;
  }
  new Compressor(LIMITER).processMono(out);
  for (let i = 0; i < out.length; i++) { if (out[i] > 1) out[i] = 1; else if (out[i] < -1) out[i] = -1; }
  return out;
}

/** A GM drum hit: fire-and-forget playback of a precomputed one-shot buffer. */
class DrumVoice implements RtVoice {
  chanKey: string;
  firstOffset: number;
  done = false;
  private pos = 0;
  private readonly buf: Float32Array;
  constructor(note: Note, chanKey: string, firstOffset: number) {
    this.chanKey = chanKey;
    this.firstOffset = firstOffset;
    this.buf = renderDrum(note.pitch, note.velocity);
  }
  render(scratch: Float32Array, start: number, count: number): void {
    const end = start + count;
    for (let i = start; i < end; i++) {
      scratch[i] = this.pos < this.buf.length ? this.buf[this.pos++] : 0;
    }
    if (this.pos >= this.buf.length) this.done = true;
  }
}

// ---- streaming reverb (wet only; state kept across blocks) ----
class StreamReverb {
  private combs: { buf: Float32Array; i: number }[];
  private aps: { buf: Float32Array; i: number }[];
  private fb: number;
  constructor(room: number, seed = 0) {
    const combLens = [1557, 1617, 1491, 1422].map((L) => L + seed);
    this.combs = combLens.map((L) => ({ buf: new Float32Array(L), i: 0 }));
    this.aps = [225, 556].map((L) => ({ buf: new Float32Array(L), i: 0 }));
    this.fb = 0.7 + 0.28 * Math.min(Math.max(room, 0), 1);
  }
  process(input: Float32Array, out: Float32Array): void {
    for (let k = 0; k < input.length; k++) {
      const dry = input[k];
      let wet = 0;
      for (const c of this.combs) {
        const y = c.buf[c.i];
        c.buf[c.i] = dry + y * this.fb;
        c.i = c.i + 1 === c.buf.length ? 0 : c.i + 1;
        wet += y;
      }
      wet *= 0.25;
      for (const a of this.aps) {
        const bufd = a.buf[a.i];
        const y = -wet + bufd;
        a.buf[a.i] = wet + bufd * 0.5;
        a.i = a.i + 1 === a.buf.length ? 0 : a.i + 1;
        wet = y;
      }
      out[k] = wet;
    }
  }
}

// ---- streaming stereo ping-pong delay (wet only; circular lines) ----
class StreamPingPong {
  private lineL: Float32Array;
  private lineR: Float32Array;
  private w = 0;
  private readonly D: number;
  private fb: number;
  private mix: number;
  constructor(d: Delay) {
    this.D = Math.max(1, Math.floor(d.time * SR));
    this.lineL = new Float32Array(this.D);
    this.lineR = new Float32Array(this.D);
    this.fb = d.feedback;
    this.mix = d.mix;
  }
  process(input: Float32Array, outL: Float32Array, outR: Float32Array): void {
    for (let k = 0; k < input.length; k++) {
      const echoL = this.lineL[this.w]; // value from D samples ago
      const echoR = this.lineR[this.w];
      this.lineL[this.w] = input[k] + this.fb * echoR; // right feeds back into left
      this.lineR[this.w] = this.fb * echoL; // left bounces to right
      outL[k] = this.mix * echoL;
      outR[k] = this.mix * echoR;
      this.w = this.w + 1 === this.D ? 0 : this.w + 1;
    }
  }
}

/** Signature strings to decide when a shared FX unit must be rebuilt. */
const reverbSig = (r?: Reverb) => (r ? `${r.room}` : "off");
const delaySig = (d?: Delay) => (d ? `${d.time}` : "off");
const compSig = (c?: RenderOptions["compress"]) => (c ? `${c.threshold}|${c.ratio}|${c.attack}|${c.release}` : "off");

/**
 * The JIT streaming synth. Holds the song + options + mixer + a pool of active
 * voices and a sample playhead. renderBlock(N) synthesizes the next N samples.
 */
export class StreamingSynth {
  private song!: Song;
  private opts!: RenderOptions;
  private sorted: { s: number; note: Note }[] = [];
  private noteIdx = 0;
  private pos = 0; // playhead in samples
  private active: RtVoice[] = [];
  private voiceFor?: (n: Note) => Voice;
  private mixer = new Map<string, ChannelMix>();

  // shared FX
  private revL?: StreamReverb;
  private revR?: StreamReverb;
  private ping?: StreamPingPong;
  private comp?: Compressor;
  private limiter = new Compressor(LIMITER);
  private revSig = "off";
  private delSig = "off";
  private cSig = "off";

  // scratch buffers (reused per block)
  private scratch = new Float32Array(0);
  private dry = new Float32Array(0);
  private revBus = new Float32Array(0);
  private delBus = new Float32Array(0);
  private wetL = new Float32Array(0);
  private wetR = new Float32Array(0);
  private dl = new Float32Array(0);
  private dr = new Float32Array(0);

  constructor(song: Song, opts: RenderOptions) {
    this.setSong(song);
    this.setOptions(opts);
  }

  get playheadSeconds(): number { return this.pos / SR; }
  get duration(): number { return this.song.duration; }

  setSong(song: Song): void {
    this.song = song;
    this.sorted = song.notes
      .map((note) => ({ s: Math.floor(note.start * SR), note }))
      .sort((a, b) => a.s - b.s);
    this.seek(0);
  }

  setOptions(opts: RenderOptions): void {
    this.opts = opts;
    this.voiceFor = opts.gm ? gmVoiceFor(this.song, opts.voiceOverrides) : undefined;
    // rebuild shared FX only when their structural params change (keeps tails)
    const rs = reverbSig(opts.reverb);
    if (rs !== this.revSig) {
      this.revSig = rs;
      this.revL = opts.reverb ? new StreamReverb(opts.reverb.room, 0) : undefined;
      this.revR = opts.reverb ? new StreamReverb(opts.reverb.room, 7) : undefined;
    }
    const ds = delaySig(opts.delay);
    if (ds !== this.delSig) {
      this.delSig = ds;
      this.ping = opts.delay ? new StreamPingPong(opts.delay) : undefined;
    }
    const cs = compSig(opts.compress);
    if (cs !== this.cSig) {
      this.cSig = cs;
      this.comp = opts.compress ? new Compressor(opts.compress) : undefined;
    }
    this.refreshActiveVoices(); // push instrument/param edits onto held notes
  }

  /** Re-resolve every sounding pitched voice against the current overrides. */
  private refreshActiveVoices(): void {
    if (!this.voiceFor) return;
    for (const voice of this.active) {
      if (voice instanceof PitchedVoice) voice.updateVoice(this.voiceFor(voice.note));
    }
  }

  /** Live-update just the reverb/delay *mix* levels without dropping FX tails. */
  updateFxMix(): void {
    // reverb.mix and delay.mix are read per block in renderBlock, nothing to do.
  }

  setMixer(m: Map<string, ChannelMix>): void { this.mixer = m; }

  seek(sample: number): void {
    this.pos = Math.max(0, Math.floor(sample));
    this.active = [];
    // first note at/after the playhead (notes already sounding aren't retriggered)
    this.noteIdx = 0;
    while (this.noteIdx < this.sorted.length && this.sorted[this.noteIdx].s < this.pos) this.noteIdx++;
    // clear FX tails so a seek doesn't smear old echoes into the new position
    if (this.opts) {
      this.revL = this.opts.reverb ? new StreamReverb(this.opts.reverb.room, 0) : undefined;
      this.revR = this.opts.reverb ? new StreamReverb(this.opts.reverb.room, 7) : undefined;
      this.ping = this.opts.delay ? new StreamPingPong(this.opts.delay) : undefined;
      this.comp = this.opts.compress ? new Compressor(this.opts.compress) : undefined;
      this.limiter = new Compressor(LIMITER);
    }
  }

  private ensureScratch(N: number): void {
    if (this.scratch.length === N) return;
    this.scratch = new Float32Array(N);
    this.dry = new Float32Array(N);
    this.revBus = new Float32Array(N);
    this.delBus = new Float32Array(N);
    this.wetL = new Float32Array(N);
    this.wetR = new Float32Array(N);
    this.dl = new Float32Array(N);
    this.dr = new Float32Array(N);
  }

  /** Resolve a channel's live mix gains (volume + mute/solo). */
  private chanGains(chanKey: string): { g: number; rev: number; del: number } {
    const m = this.mixer.get(chanKey);
    const anySolo = this.hasSolo();
    if (!m) return { g: anySolo ? 0 : 1, rev: 0.25, del: 0 };
    let g = m.volume;
    if (anySolo) g = m.solo ? g : 0;
    else if (m.mute) g = 0;
    return { g, rev: m.reverbSend, del: m.delaySend };
  }
  private soloCache = { valid: false, any: false };
  private hasSolo(): boolean {
    // recomputed each block via invalidate(); cheap linear scan otherwise
    if (this.soloCache.valid) return this.soloCache.any;
    let any = false;
    for (const m of this.mixer.values()) if (m.solo) { any = true; break; }
    this.soloCache = { valid: true, any };
    return any;
  }

  /** Synthesize the next N samples. Returns [L, R] (mono => L===R content). */
  renderBlock(N: number): [Float32Array, Float32Array] {
    this.ensureScratch(N);
    this.soloCache.valid = false; // mixer may have changed since last block
    const { dry, revBus, delBus, scratch } = this;
    dry.fill(0); revBus.fill(0); delBus.fill(0);

    // spawn voices whose onset falls in this block
    const blockEnd = this.pos + N;
    while (this.noteIdx < this.sorted.length && this.sorted[this.noteIdx].s < blockEnd) {
      const { s, note } = this.sorted[this.noteIdx];
      this.noteIdx++;
      const offset = Math.max(0, s - this.pos);
      if (note.channel === 9) {
        if (!this.opts.drums) continue;
        this.active.push(new DrumVoice(note, `${note.track}:${note.channel}`, offset));
      } else {
        const v = this.voiceFor ? this.voiceFor(note) : (this.opts as unknown as Voice);
        this.active.push(new PitchedVoice(note, v, this.opts.vibrato, `${note.track}:${note.channel}`, offset));
      }
    }

    // advance every active voice, routing its output into the three buses
    const next: RtVoice[] = [];
    for (const voice of this.active) {
      const start = voice.firstOffset;
      voice.firstOffset = 0;
      const count = N - start;
      if (count <= 0) { next.push(voice); continue; }
      voice.render(scratch, start, count);
      const { g, rev, del } = this.chanGains(voice.chanKey);
      if (g !== 0) {
        for (let i = start; i < N; i++) dry[i] += g * scratch[i];
        if (rev > 0) { const gr = g * rev; for (let i = start; i < N; i++) revBus[i] += gr * scratch[i]; }
        if (del > 0) { const gd = g * del; for (let i = start; i < N; i++) delBus[i] += gd * scratch[i]; }
      }
      if (!voice.done) next.push(voice);
    }
    this.active = next;

    // sanitize before the feedback FX: a runaway per-channel gain could otherwise
    // drive a reverb/delay comb to Inf, and Inf poisons its state forever (silence
    // that persists even after the gain is turned back down). Clamp to a finite
    // ceiling — extreme gain then just distorts instead of killing the engine.
    for (let i = 0; i < N; i++) {
      dry[i] = clampFinite(dry[i]);
      revBus[i] = clampFinite(revBus[i]);
      delBus[i] = clampFinite(delBus[i]);
    }

    // shared send FX -> widen to stereo
    const L = new Float32Array(N);
    const R = new Float32Array(N);
    L.set(dry); R.set(dry);
    if (this.revL && this.revR && this.opts.reverb) {
      const mix = this.opts.reverb.mix;
      this.revL.process(revBus, this.wetL);
      this.revR.process(revBus, this.wetR);
      for (let i = 0; i < N; i++) { L[i] += mix * this.wetL[i]; R[i] += mix * this.wetR[i]; }
    }
    if (this.ping) {
      this.ping.process(delBus, this.dl, this.dr);
      for (let i = 0; i < N; i++) { L[i] += this.dl[i]; R[i] += this.dr[i]; }
    }

    // master: fixed gain -> compressor (opt) -> limiter -> clamp
    for (let i = 0; i < N; i++) { L[i] *= MASTER_GAIN; R[i] *= MASTER_GAIN; }
    if (this.comp) this.comp.processStereo(L, R);
    this.limiter.processStereo(L, R);
    let bad = false;
    for (let i = 0; i < N; i++) {
      if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) { bad = true; break; }
      if (L[i] > 1) L[i] = 1; else if (L[i] < -1) L[i] = -1;
      if (R[i] > 1) R[i] = 1; else if (R[i] < -1) R[i] = -1;
    }
    // Self-heal: if any stateful node blew up to NaN/Inf (a hot signal ringing a
    // resonant filter), the poison would persist forever and silence the engine
    // even after the gain is lowered. Reset every stateful FX and drop the stuck
    // voices — the engine recovers within one block instead of dying.
    if (bad) {
      L.fill(0); R.fill(0);
      this.active = this.active.filter((v) => !(v instanceof PitchedVoice)); // drop pitched voices; drums are one-shots
      this.comp = this.opts.compress ? new Compressor(this.opts.compress) : undefined;
      this.limiter = new Compressor(LIMITER);
      this.revL = this.opts.reverb ? new StreamReverb(this.opts.reverb.room, 0) : undefined;
      this.revR = this.opts.reverb ? new StreamReverb(this.opts.reverb.room, 7) : undefined;
      this.ping = this.opts.delay ? new StreamPingPong(this.opts.delay) : undefined;
    }

    this.pos += N;
    return [L, R];
  }
}
