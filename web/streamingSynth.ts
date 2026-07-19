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
  type Delay,
  type FormantConfig,
  type SympatheticVoice,
  type AmpConfig,
  Compressor,
  VOWELS,
  gmVoiceFor,
  ksStringSetup,
  seedString,
  BODY_MODES,
  BODY_NORM,
} from "../synth.ts";
import { renderDrum } from "../drums.ts";

const SR = 44100;
const midiToHz = (pitch: number): number => 440 * 2 ** ((pitch - 69) / 12);

// A fixed makeup gain feeding the compressor/limiter. Streaming can't peek at
// the whole song to peak-normalize (offline's masterGain), so we use a static
// gain and let the compressor + limiter control the ceiling.
export const MASTER_GAIN = 1.25;
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
/** RBJ low-pass (2-pole) — the speaker cabinet's high roll-off. */
function lowpass(f: number, q: number): Biquad {
  const w0 = (2 * Math.PI * Math.min(f, SR * 0.45)) / SR;
  const c = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.max(q, 0.1));
  const a0 = 1 + alpha;
  return { b0: ((1 - c) / 2) / a0, b1: (1 - c) / a0, b2: ((1 - c) / 2) / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0 };
}
/** RBJ peaking EQ — the amp's midrange presence bump. */
function peaking(f: number, q: number, gainDb: number): Biquad {
  const w0 = (2 * Math.PI * f) / SR;
  const c = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.max(q, 0.1)), A = 10 ** (gainDb / 40);
  const a0 = 1 + alpha / A;
  return { b0: (1 + alpha * A) / a0, b1: (-2 * c) / a0, b2: (1 - alpha * A) / a0, a1: (-2 * c) / a0, a2: (1 - alpha / A) / a0 };
}

/** One biquad's stateful sample step. */
function biquad(c: Biquad, s: number[], x: number): number {
  const y = c.b0 * x + c.b1 * s[0] + c.b2 * s[1] - c.a1 * s[2] - c.a2 * s[3];
  s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
  return y;
}

/**
 * Guitar amp + speaker-cabinet stage (per voice): high-pass (kill rumble) ->
 * tube-ish soft clip -> midrange presence peak -> cabinet low-pass -> makeup.
 * The cabinet low-pass is the big "electric guitar" cue a bare string lacks.
 */
class AmpStage {
  private hpLp = 0;
  private readonly hpA = 1 - Math.exp((-2 * Math.PI * 90) / SR); // ~90 Hz high-pass
  private readonly pk: Biquad; private readonly pkS = [0, 0, 0, 0];
  private readonly lp: Biquad; private readonly lpS = [0, 0, 0, 0];
  private readonly drive: number; private readonly driveNorm: number; private readonly level: number;
  constructor(cfg: AmpConfig) {
    // Clamp every field finite BEFORE it reaches a filter coeff or 1/tanh: a NaN
    // presence -> NaN peaking coeffs, a NaN/0 drive -> NaN driveNorm, and either
    // one latches the biquad state to NaN so the voice is silent forever (the
    // "moving Presence silences it" bug). Clamped, any value stays stable/finite.
    const presence = Number.isFinite(cfg.presence) ? Math.min(Math.max(cfg.presence, 0), 1) : 0;
    const cabLow = Number.isFinite(cfg.cabLow) ? Math.min(Math.max(cfg.cabLow, 200), 20000) : 20000;
    this.pk = peaking(2200, 1.0, 5 * presence); // up to +5 dB
    this.lp = lowpass(cabLow, 0.7);
    this.drive = Number.isFinite(cfg.drive) ? Math.max(1, cfg.drive) : 1;
    this.driveNorm = 1 / Math.tanh(this.drive);
    this.level = Number.isFinite(cfg.level) ? Math.min(Math.max(cfg.level, 0), 4) : 1;
  }
  process(x: number): number {
    this.hpLp += this.hpA * (x - this.hpLp);
    x = x - this.hpLp; // high-pass
    x = Math.tanh(x * this.drive) * this.driveNorm; // tube-ish soft clip
    x = biquad(this.pk, this.pkS, x); // presence
    x = biquad(this.lp, this.lpS, x); // cabinet roll-off
    return x * this.level;
  }
}

// ---- per-channel mixer state ----
export interface ChannelMix {
  volume: number; // 0..1 fader (separate from the patch's voiceOverride.gain)
  mute: boolean;
  solo: boolean;
  // Send matrix: send level (0..1) to each FX instance, keyed by its id. This is
  // the per-channel × per-effect routing — a channel can feed any number of the
  // effect instances at independent levels. Serializable (plain number map).
  sends: Record<string, number>;
  // Legacy pre-matrix send fields. Kept optional so old localStorage/.chip
  // configs still deserialize; app.ts migrates them into `sends` on load.
  reverbSend?: number;
  delaySend?: number;
  chorusSend?: number;
}
export function defaultChannelMix(): ChannelMix {
  return { volume: 1, mute: false, solo: false, sends: {} };
}

/** A modulated-delay chorus (the shimmery, doubled Cure/80s sound). */
export interface Chorus {
  rate: number; // LFO rate, Hz (~0.1..6)
  depth: number; // 0..1 modulation depth (mapped to a few ms of delay sweep)
  mix: number; // 0..1 wet level
}

// ---- dynamic effects stack ----
export type FxType = "reverb" | "delay" | "chorus";
/**
 * One user-configurable effect instance in the rack. `params` is a flat, fully
 * serializable number map whose keys depend on `type`:
 *   reverb: { room, mix }          (mix = return/wet level)
 *   delay:  { time, feedback, mix }
 *   chorus: { rate, depth, mix }
 * Any number of instances of any type may coexist; each channel routes to each
 * via ChannelMix.sends[id].
 */
export interface FxInstance {
  id: string;
  type: FxType;
  name: string;
  enabled: boolean;
  params: Record<string, number>;
}

/** Web-only options: the shared RenderOptions plus the dynamic effects stack. */
export type WebRenderOptions = RenderOptions & { chorus?: Chorus; fx?: FxInstance[] };

const numOr = (x: unknown, d: number): number =>
  Number.isFinite(x as number) ? (x as number) : d;

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

/** A patch gain that can never poison the signal: `NaN ?? 1` is NaN (?? only
 *  catches null/undefined), and a NaN gain makes every sample NaN. Force finite
 *  and non-negative, defaulting to 1. */
function safeGain(g: number | undefined): number {
  return Number.isFinite(g) && (g as number) >= 0 ? (g as number) : 1;
}

/** Which engine a Voice selects (matches the constructor's branch order). */
function voiceEngine(v: Voice): "add" | "fm" | "sub" | "formant" | "ks" {
  if (v.ks) return "ks";
  if (v.formant) return "formant";
  if (v.sub) return "sub";
  if (v.fm) return "fm";
  return "add";
}

export class PitchedVoice implements RtVoice {
  chanKey: string;
  firstOffset: number;
  done = false;
  private k = 0;
  private n: number; // total samples (mutable: live/held release re-times the end)
  private a: number; // attack samples (mutable: live edits)
  private r: number; // release samples
  private releasing = false; // live-held: release() begun
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
  private ksLines: Float32Array[] = []; private ksIdx!: Int32Array; private ksLi!: Int32Array; // KS: per-string delay lines
  private ksC!: Float64Array; private ksDisp!: Float64Array; private ksB = 0; private ksDecay = 1; // per-string tuning/dispersion coeffs; shared damping/decay
  private ksLpA = 1; private ksLpState!: Float64Array; // Extended-KS loop loss filter (1 = off)
  private ksNorm = 1; // multi-string sum normalization (1/sqrt(strings))
  private dX1!: Float64Array; private dY1!: Float64Array; private tX1!: Float64Array; private tY1!: Float64Array; private dampPrev!: Float64Array; // KS loop filter state (per string)
  private bodyC?: (Biquad & { g: number })[]; // modal body resonator bank
  private bodyState?: Float64Array; // [x1,x2,y1,y2] per body mode
  private ampStage?: AmpStage; // guitar amp + cabinet voicing

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
    this.amp = (note.velocity / 127) ** 1.5 * 0.25 * safeGain(v.gain);

    if (v.ks) {
      this.engine = "ks";
      // velocity -> brightness: a harder pluck raises the effective pick `tone` (mirrors renderKs)
      const velBright = Math.min(Math.max(v.ks.velBright ?? 0, 0), 1);
      const vel = note.velocity / 127;
      const effTone = Math.min(Math.max((v.ks.tone ?? 1) + velBright * (vel - 0.5), 0), 1);
      // multi-string unison: `ns` detuned strings, each its own delay line, summed
      const ns = Math.min(Math.max(Math.floor(v.ks.strings ?? 1), 1), 3);
      const spread = v.ks.spread ?? 0;
      this.ksNorm = 1 / Math.sqrt(ns);
      this.ksLi = new Int32Array(ns); this.ksC = new Float64Array(ns); this.ksDisp = new Float64Array(ns); this.ksIdx = new Int32Array(ns);
      this.dX1 = new Float64Array(ns); this.dY1 = new Float64Array(ns); this.tX1 = new Float64Array(ns); this.tY1 = new Float64Array(ns); this.dampPrev = new Float64Array(ns);
      this.ksLpState = new Float64Array(ns);
      for (let s = 0; s < ns; s++) {
        const cents = ns > 1 ? (s / (ns - 1) - 0.5) * spread : 0;
        const setup = ksStringSetup(freq * 2 ** (cents / 1200), v.ks);
        this.ksLi[s] = setup.Li; this.ksC[s] = setup.C; this.ksDisp[s] = setup.disp; this.ksB = setup.b; this.ksDecay = setup.decay; this.ksLpA = setup.lpA;
        this.ksLines[s] = seedString(setup.Li, v.ks.pick ?? 0, effTone);
      }
      // pre-darken the excitation to the loop cutoff (smooth fingered attack, no
      // noise burst on heavily-damped strings); re-normalize energy. Mirrors renderKs.
      if (this.ksLpA < 1) {
        const fadeN = Math.min(Math.floor(0.003 * SR), 256); // ~3ms fade-in -> no onset click
        for (let s = 0; s < ns; s++) {
          const seed = this.ksLines[s]; let lp = 0, ss = 0;
          for (let i = 0; i < seed.length; i++) { lp += this.ksLpA * (seed[i] - lp); seed[i] = lp; ss += lp * lp; }
          const rms = Math.sqrt(ss / seed.length);
          const g = rms > 1e-6 ? 0.5774 / rms : 1;
          const fN = Math.min(fadeN, seed.length >> 1);
          for (let i = 0; i < seed.length; i++) { let x = seed[i] * g; if (i < fN) x *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fN); seed[i] = x; }
        }
      }
      if ((v.ks.body ?? 0) > 0) { this.bodyC = BODY_MODES.map((m) => ({ ...bandpass(m.f, m.q), g: m.g })); this.bodyState = new Float64Array(this.bodyC.length * 4); }
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
    if (v.amp) this.ampStage = new AmpStage(v.amp);
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
    this.amp = (this.note.velocity / 127) ** 1.5 * 0.25 * safeGain(v.gain);
    // KS: the per-sample loop coefficients (damping, decay) are safe to change on
    // a ringing note, so a held note responds live to those knobs. Tuning/dispersion
    // and the pluck seed (pick/tone/strings/stiffness) are baked at note start —
    // you can't change a vibrating string's geometry, only re-pluck it.
    if (this.engine === "ks" && v.ks) {
      const dRaw = Number.isFinite(v.ks.damping) ? Math.min(Math.max(v.ks.damping, 0), 1) : 0.5;
      this.ksB = 0.5 * dRaw;
      this.ksDecay = Number.isFinite(v.ks.decay) ? Math.min(Math.max(v.ks.decay, 0), 1) : 0.996;
    }
  }

  /**
   * Begin the release ramp from the CURRENT position (for a live/held note built
   * with a very long duration). Re-times the note end to `k + r` so env()'s
   * smoothstep release window starts now; the voice marks itself done once the
   * ramp finishes. Idempotent. A small floor on r avoids a click if the patch has
   * zero release. Naturally-decaying engines (KS) keep ringing out regardless.
   */
  release(): void {
    if (this.releasing) return;
    this.releasing = true;
    const minR = Math.floor(0.012 * SR); // ~12 ms floor -> no click on cut
    this.r = Math.max(this.r, minR);
    this.n = this.k + this.r;
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
        // Extended KS: dispersion all-pass (stiffness) -> tuning all-pass -> damping
        // -> decay, in the feedback loop; body resonators on the output tap. Mirrors
        // renderKs() in synth.ts (setup shared via ksStringSetup/seedString). Multi-
        // string unison + release-damping are mirrored here too.
        const ns = this.ksLines.length;
        const b = this.ksB, decay = this.ksDecay, norm = this.ksNorm;
        const ksBody = this.v.ks?.body ?? 0;
        const relDamp = Math.min(Math.max(this.v.ks?.releaseDamp ?? 0, 0), 1);
        const relStart = relDamp > 0 && this.r > 0 ? this.n - this.r : this.n; // matches env() release window
        for (let i = start; i < end; i++) {
          if (this.k >= this.n) { scratch[i] = 0; continue; }
          // release damping ramp: choke the string (b->1, decay drops) across the release
          let bK = b, decayK = decay;
          if (this.k >= relStart) {
            const rt = (this.k - relStart) / Math.max(this.r, 1);
            bK = b + (0.5 - b) * relDamp * rt; // ramp toward b=0.5 (the averager's darkest), not 1 (which re-brightens)
            decayK = decay * (1 - 0.5 * relDamp * rt);
          }
          let mix = 0;
          for (let s = 0; s < ns; s++) {
            const line = this.ksLines[s], L = this.ksLi[s], C = this.ksC[s], disp = this.ksDisp[s], p = this.ksIdx[s];
            const cur = line[p];
            const dOut = disp * cur + this.dX1[s] - disp * this.dY1[s]; this.dX1[s] = cur; this.dY1[s] = dOut;
            const tOut = C * dOut + this.tX1[s] - C * this.tY1[s]; this.tX1[s] = dOut; this.tY1[s] = tOut;
            let lp = (1 - bK) * tOut + bK * this.dampPrev[s]; this.dampPrev[s] = tOut;
            if (this.ksLpA < 1) { this.ksLpState[s] += this.ksLpA * (lp - this.ksLpState[s]); lp = this.ksLpState[s]; } // Extended-KS loop loss
            let fb = lp * decayK;
            if (!Number.isFinite(fb)) fb = 0;
            line[p] = fb;
            this.ksIdx[s] = p + 1 === L ? 0 : p + 1;
            mix += cur;
          }
          mix *= norm;
          let out = mix;
          if (this.bodyC) { // modal body resonator bank (mirrors renderKs)
            const bc = this.bodyC, bs = this.bodyState!;
            let bsum = 0;
            for (let m = 0; m < bc.length; m++) {
              const c = bc[m], o = m * 4;
              const y = c.b0 * mix + c.b1 * bs[o] + c.b2 * bs[o + 1] - c.a1 * bs[o + 2] - c.a2 * bs[o + 3];
              bs[o + 1] = bs[o]; bs[o] = mix; bs[o + 3] = bs[o + 2]; bs[o + 2] = y;
              bsum += c.g * y;
            }
            out = mix + ksBody * BODY_NORM * bsum;
          }
          // pick/finger contact-noise transient at the attack (mirrors renderKs)
          const pluckNoise = Math.min(Math.max(this.v.ks?.pluckNoise ?? 0, 0), 1);
          if (pluckNoise > 0 && this.k < Math.floor(0.006 * SR)) out += (Math.random() * 2 - 1) * pluckNoise * Math.exp(-this.k / (0.0015 * SR));
          const y = out * amp * this.env(this.k);
          scratch[i] = Number.isFinite(y) ? y : 0; // never let the feedback loop leak NaN downstream (poisons ctx)
          this.k++;
        }
        break;
      }
    }
    // amp/cabinet voicing (electric guitar): post-process the enveloped output
    if (this.ampStage) {
      for (let i = start; i < end; i++) {
        let y = this.ampStage.process(scratch[i]);
        scratch[i] = Number.isFinite(y) ? y : 0;
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
  // Sanitize before this buffer reaches Web Audio. A single NaN/Inf sample fed to
  // ctx.destination poisons the ENTIRE AudioContext permanently (total silence
  // until page refresh) — and `x > 1` is false for NaN, so a bare clamp lets it
  // through. Map non-finite -> 0, then clamp finite to [-1, 1].
  for (let i = 0; i < out.length; i++) {
    const x = out[i];
    out[i] = !Number.isFinite(x) ? 0 : x > 1 ? 1 : x < -1 ? -1 : x;
  }
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
// Freeverb-style: 8 damped comb filters in parallel -> 4 allpasses in series.
// Bigger/longer than a bare Schroeder — the combs are lengthened for a larger
// space, feedback reaches ~0.98 for a long tail, and each comb has a low-pass in
// its loop so the tail stays smooth/natural instead of metallic.
class StreamReverb {
  private combs: { buf: Float32Array; i: number; store: number }[];
  private aps: { buf: Float32Array; i: number }[];
  private readonly fb: number; // room size (comb feedback)
  private readonly damp1: number; // hf damping in the comb loop
  private readonly damp2: number;
  constructor(room: number, seed = 0) {
    const r = Math.min(Math.max(room, 0), 1);
    // Freeverb comb tunings, scaled ~1.5x for a bigger room; stereo decorrelated by seed
    const combLens = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((L) => Math.round(L * 1.5) + seed);
    this.combs = combLens.map((L) => ({ buf: new Float32Array(L), i: 0, store: 0 }));
    this.aps = [556, 441, 341, 225].map((L) => ({ buf: new Float32Array(L + seed), i: 0 }));
    this.fb = 0.82 + 0.16 * r; // up to ~0.98 -> long tail
    this.damp1 = 0.2; // gentle high-frequency damping
    this.damp2 = 1 - this.damp1;
  }
  process(input: Float32Array, out: Float32Array): void {
    for (let k = 0; k < input.length; k++) {
      const dry = input[k];
      let wet = 0;
      for (const c of this.combs) {
        const y = c.buf[c.i];
        c.store = y * this.damp2 + c.store * this.damp1; // low-pass in the feedback
        c.buf[c.i] = dry + c.store * this.fb;
        c.i = c.i + 1 === c.buf.length ? 0 : c.i + 1;
        wet += y;
      }
      wet *= 0.15; // 8 combs summed
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
  /** Live-update feedback/mix without clearing the delay line (time is structural
   *  and needs a rebuild; these don't). */
  set(d: Delay): void {
    this.fb = numOr(d.feedback, this.fb);
    this.mix = numOr(d.mix, this.mix);
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

// ---- streaming stereo chorus (wet only; modulated delay lines) ----
// Three LFO-modulated fractional delay lines tapped off a shared circular
// buffer, phase-spread and panned across the stereo field. Each voice sweeps a
// short base delay (~18 ms) by a few ms; summing the detuned copies gives the
// thick, shimmering doubling that defines the Cure's guitars/synths. Wet only:
// renderBlock adds mix*wet into L/R just like the reverb/delay send buses.
class StreamChorus {
  private buf: Float32Array;
  private w = 0;
  private readonly mask: number;
  private readonly size: number;
  private readonly phase: Float64Array; // per-voice LFO phase (0..1)
  private readonly nVoices = 3;
  private readonly baseSamp: number;
  private readonly depthSamp: number;
  private readonly lfoInc: number;
  constructor(c: Chorus) {
    const rate = Number.isFinite(c.rate) ? Math.min(Math.max(c.rate, 0.05), 8) : 1;
    const depth = Number.isFinite(c.depth) ? Math.min(Math.max(c.depth, 0), 1) : 0.5;
    this.baseSamp = 0.018 * SR; // ~18 ms base delay
    this.depthSamp = (1 + depth * 6) * 0.001 * SR; // depth 0..1 -> 1..7 ms sweep
    this.lfoInc = rate / SR;
    const maxDelay = this.baseSamp + this.depthSamp + 4;
    let size = 2;
    while (size < maxDelay) size <<= 1; // power-of-two so reads mask cheaply
    this.size = size;
    this.mask = size - 1;
    this.buf = new Float32Array(size);
    this.phase = new Float64Array(this.nVoices);
    for (let v = 0; v < this.nVoices; v++) this.phase[v] = v / this.nVoices; // spread LFOs
  }
  process(input: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const buf = this.buf, mask = this.mask, size = this.size;
    for (let k = 0; k < input.length; k++) {
      const x = input[k];
      buf[this.w] = Number.isFinite(x) ? x : 0;
      let l = 0, r = 0, mid = 0;
      for (let v = 0; v < this.nVoices; v++) {
        let ph = this.phase[v] + this.lfoInc;
        if (ph >= 1) ph -= 1;
        this.phase[v] = ph;
        const lfo = Math.sin(2 * Math.PI * ph);
        const d = this.baseSamp + this.depthSamp * (0.5 + 0.5 * lfo); // unipolar sweep
        let rp = this.w - d;
        while (rp < 0) rp += size;
        const i0 = rp | 0;
        const frac = rp - i0;
        const s0 = buf[i0 & mask];
        const s1 = buf[(i0 + 1) & mask];
        let s = s0 + (s1 - s0) * frac;
        if (!Number.isFinite(s)) s = 0;
        if (v === 0) l += s; else if (v === 1) mid += s; else r += s; // pan spread
      }
      this.w = this.w + 1 === size ? 0 : this.w + 1;
      const scale = 1 / 1.6;
      outL[k] = (l + 0.6 * mid) * scale;
      outR[k] = (r + 0.6 * mid) * scale;
    }
  }
}

/**
 * Per-instrument sympathetic resonance (streaming): a bank of tuned string
 * resonators, driven by one channel's signal, ringing in sympathy. Stateful
 * across blocks. Ported from synth.ts's sympatheticWet but fixed-mix (streaming
 * can't peek at the whole buffer to peak-normalise) — presets set `mix` directly.
 */
class SympatheticBank {
  private readonly lines: Float32Array[];
  private readonly idx: Int32Array;
  private readonly lp: Float64Array;
  private readonly prevOut: Float64Array;
  private readonly curOut: Float64Array;
  private readonly coupled: number[][];
  private readonly N: number;
  private readonly feedback: number;
  private readonly damping: number;
  private readonly couple = 0.03;
  private readonly drive: number;
  private readonly mix: number;
  private envFast = 0;
  private envSlow = 0;
  private readonly cf: number;
  private readonly cs: number;
  input: Float32Array = new Float32Array(0); // this block's channel signal

  constructor(cfg: SympatheticVoice) {
    // A resonator bank driven live from the instrument editor's "Ring time"
    // (feedback) slider must never be able to blow up: sanitize every config
    // field before it reaches the loop. feedback is capped strictly below 1 so a
    // high setting just rings *longer* (a longer natural decay) instead of turning
    // the tanh feedback path into a runaway self-oscillator.
    const clamp = (x: number, lo: number, hi: number, dflt: number) =>
      Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : dflt;
    const strings = (cfg.strings ?? []).filter((m) => Number.isFinite(m));
    const freqs = (strings.length ? strings : [40, 45, 50, 55, 59, 64]).map((m) => 440 * 2 ** ((m - 69) / 12));
    this.N = freqs.length;
    this.lines = freqs.map((f) => new Float32Array(Math.max(2, Math.round(SR / f))));
    this.idx = new Int32Array(this.N);
    this.lp = new Float64Array(this.N);
    this.prevOut = new Float64Array(this.N);
    this.curOut = new Float64Array(this.N);
    const base = freqs[0];
    const semis = freqs.map((f) => Math.round(12 * Math.log2(f / base)));
    this.coupled = freqs.map(() => [] as number[]);
    for (let i = 0; i < this.N; i++)
      for (let j = 0; j < this.N; j++) {
        if (i === j) continue;
        const d = Math.abs(semis[i] - semis[j]);
        if (d === 12 || d === 7) this.coupled[i].push(j); // octave / fifth bridge coupling
      }
    this.feedback = clamp(cfg.feedback, 0, 0.98, 0.55); // < 1 -> always a decaying resonator, never a runaway
    this.damping = clamp(cfg.damping, 0, 1, 0.35);
    this.mix = clamp(cfg.mix, 0, 4, 0);
    this.drive = 1.2 / Math.sqrt(this.N);
    this.cf = 1 - Math.exp(-1 / (0.002 * SR)); // fast onset-gate env (~2ms)
    this.cs = 1 - Math.exp(-1 / (0.06 * SR)); // slow onset-gate env (~60ms)
  }

  /** Resize + clear this block's input accumulator. */
  ensure(N: number): void {
    if (this.input.length !== N) this.input = new Float32Array(N);
    else this.input.fill(0);
  }

  /** Run the resonators over this.input, adding mix*wet into out[0..N). */
  flush(out: Float32Array, N: number): void {
    const inp = this.input;
    for (let k = 0; k < N; k++) {
      const x = Number.isFinite(inp[k]) ? inp[k] : 0; // never let a poisoned bus sample seed the resonators
      const a = Math.abs(x);
      this.envFast += this.cf * (a - this.envFast);
      this.envSlow += this.cs * (a - this.envSlow);
      const gate = Math.max(0, this.envFast - this.envSlow); // onset transient drives the strings
      const exc = x * (0.1 + gate * 6);
      let wet = 0;
      for (let i = 0; i < this.N; i++) {
        const line = this.lines[i];
        const p = this.idx[i];
        const yD = line[p];
        this.lp[i] += this.damping * (yD - this.lp[i]);
        if (!Number.isFinite(this.lp[i])) this.lp[i] = 0; // keep the loop filter finite
        let couple = 0;
        const nb = this.coupled[i];
        for (let c = 0; c < nb.length; c++) couple += this.prevOut[nb[c]];
        let y = Math.tanh(exc * this.drive + this.feedback * this.lp[i] + this.couple * couple);
        if (!Number.isFinite(y)) y = 0;
        line[p] = y;
        this.idx[i] = p + 1 === line.length ? 0 : p + 1;
        this.curOut[i] = y;
        wet += y;
      }
      this.prevOut.set(this.curOut);
      out[k] += this.mix * wet;
    }
  }
}

const compSig = (c?: RenderOptions["compress"]) => (c ? `${c.threshold}|${c.ratio}|${c.attack}|${c.release}` : "off");

/**
 * A live effect-rack instance: the persisted FxInstance config plus the actual
 * stateful DSP processor(s) and this block's send bus / wet scratch. One per
 * FxInstance in the stack. `sig` captures the *structural* params (the ones that
 * need the processor rebuilt on change); level/mix params update in place.
 */
interface LiveFx {
  id: string;
  type: FxType;
  enabled: boolean;
  params: Record<string, number>;
  sig: string;
  bus: Float32Array; // Σ over channels of send*gain*voice, this block
  wetL: Float32Array;
  wetR: Float32Array;
  revL?: StreamReverb;
  revR?: StreamReverb;
  ping?: StreamPingPong;
  chorus?: StreamChorus;
}

/** Structural signature — changing any of these forces a processor rebuild. */
function fxSig(f: { type: FxType; params: Record<string, number> }): string {
  const p = f.params;
  if (f.type === "reverb") return `rev|${numOr(p.room, 0.82)}`;
  if (f.type === "delay") return `del|${numOr(p.time, 0.32)}`;
  return `cho|${numOr(p.rate, 1.2)}|${numOr(p.depth, 0.5)}`;
}

/** (Re)build a LiveFx's DSP processors from its current params. */
function buildFxProcessors(f: LiveFx): void {
  const p = f.params;
  f.revL = f.revR = undefined;
  f.ping = undefined;
  f.chorus = undefined;
  if (f.type === "reverb") {
    const room = numOr(p.room, 0.82);
    f.revL = new StreamReverb(room, 0);
    f.revR = new StreamReverb(room, 7);
  } else if (f.type === "delay") {
    f.ping = new StreamPingPong({ time: numOr(p.time, 0.32), feedback: numOr(p.feedback, 0.4), mix: numOr(p.mix, 0.35) });
  } else {
    f.chorus = new StreamChorus({ rate: numOr(p.rate, 1.2), depth: numOr(p.depth, 0.5), mix: numOr(p.mix, 0.5) });
  }
}

/**
 * The JIT streaming synth. Holds the song + options + mixer + a pool of active
 * voices and a sample playhead. renderBlock(N) synthesizes the next N samples.
 */
export class StreamingSynth {
  private song!: Song;
  private opts!: WebRenderOptions;
  private sorted: { s: number; note: Note }[] = [];
  private noteIdx = 0;
  private pos = 0; // playhead in samples
  private active: RtVoice[] = [];
  private voiceFor?: (n: Note) => Voice;
  private mixer = new Map<string, ChannelMix>();
  private symBanks = new Map<string, SympatheticBank>(); // per-channel sympathetic strings

  // dynamic effects stack (one LiveFx per FxInstance in opts.fx)
  private fx: LiveFx[] = [];
  private comp?: Compressor;
  private limiter = new Compressor(LIMITER);
  private cSig = "off";

  // scratch buffers (reused per block)
  private scratch = new Float32Array(0);
  private dry = new Float32Array(0);

  constructor(song: Song, opts: WebRenderOptions) {
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

  setOptions(opts: WebRenderOptions): void {
    this.opts = opts;
    this.voiceFor = opts.gm ? gmVoiceFor(this.song, opts.voiceOverrides) : undefined;
    this.syncFx(opts.fx ?? []);
    const cs = compSig(opts.compress);
    if (cs !== this.cSig) {
      this.cSig = cs;
      this.comp = opts.compress ? new Compressor(opts.compress) : undefined;
    }
    this.symBanks.clear(); // rebuilt from voices; picks up any sympathetic edits
    this.refreshActiveVoices(); // push instrument/param edits onto held notes
  }

  /**
   * Reconcile the live effect rack with the requested FxInstance list. Existing
   * instances (matched by id) keep their DSP state — their processors are rebuilt
   * only when a structural param changes; level/mix params update in place, so a
   * reverb tail / delay echoes survive a slider move. New ids are created, dropped
   * ids removed. Order follows `list`.
   */
  private syncFx(list: FxInstance[]): void {
    const byId = new Map(this.fx.map((f) => [f.id, f]));
    const N = this.scratch.length;
    const next: LiveFx[] = [];
    for (const inst of list) {
      const params = { ...inst.params };
      let f = byId.get(inst.id);
      if (!f || f.type !== inst.type) {
        f = {
          id: inst.id, type: inst.type, enabled: inst.enabled, params,
          sig: fxSig(inst),
          bus: new Float32Array(N), wetL: new Float32Array(N), wetR: new Float32Array(N),
        };
        buildFxProcessors(f);
      } else {
        f.enabled = inst.enabled;
        f.params = params;
        const sig = fxSig(inst);
        if (sig !== f.sig) { f.sig = sig; buildFxProcessors(f); }
        else if (f.type === "delay" && f.ping) {
          f.ping.set({ time: numOr(params.time, 0.32), feedback: numOr(params.feedback, 0.4), mix: numOr(params.mix, 0.35) });
        }
      }
      next.push(f);
    }
    this.fx = next;
  }

  /** Rebuild every FX processor (drops tails) — used on seek and self-heal. */
  private rebuildAllFx(): void {
    for (const f of this.fx) buildFxProcessors(f);
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
    this.symBanks.clear(); // drop sympathetic ring tails so a seek doesn't smear
    // first note at/after the playhead (notes already sounding aren't retriggered)
    this.noteIdx = 0;
    while (this.noteIdx < this.sorted.length && this.sorted[this.noteIdx].s < this.pos) this.noteIdx++;
    // clear FX tails so a seek doesn't smear old echoes into the new position
    if (this.opts) {
      this.rebuildAllFx();
      this.comp = this.opts.compress ? new Compressor(this.opts.compress) : undefined;
      this.limiter = new Compressor(LIMITER);
    }
  }

  private ensureScratch(N: number): void {
    if (this.scratch.length === N) return;
    this.scratch = new Float32Array(N);
    this.dry = new Float32Array(N);
    // each live FX carries its own send bus + wet scratch, sized to the block
    for (const f of this.fx) {
      f.bus = new Float32Array(N);
      f.wetL = new Float32Array(N);
      f.wetR = new Float32Array(N);
    }
  }

  /** Resolve a channel's live gain (volume + mute/solo) and its send map. */
  private chanGains(chanKey: string): { g: number; sends?: Record<string, number> } {
    const m = this.mixer.get(chanKey);
    const anySolo = this.hasSolo();
    if (!m) return { g: anySolo ? 0 : 1 };
    let g = m.volume;
    if (anySolo) g = m.solo ? g : 0;
    else if (m.mute) g = 0;
    return { g, sends: m.sends };
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
    const { dry, scratch, fx } = this;
    dry.fill(0);
    for (const f of fx) f.bus.fill(0);

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
        const chanKey = `${note.track}:${note.channel}`;
        const v = this.voiceFor ? this.voiceFor(note) : (this.opts as unknown as Voice);
        if (v.sympathetic && !this.symBanks.has(chanKey)) this.symBanks.set(chanKey, new SympatheticBank(v.sympathetic));
        this.active.push(new PitchedVoice(note, v, this.opts.vibrato, chanKey, offset));
      }
    }

    // reset each sympathetic bank's input accumulator for this block
    for (const bank of this.symBanks.values()) bank.ensure(N);

    // advance every active voice, routing its output into the dry bus and into
    // each enabled FX instance's send bus per the channel's send matrix
    const next: RtVoice[] = [];
    for (const voice of this.active) {
      const start = voice.firstOffset;
      voice.firstOffset = 0;
      const count = N - start;
      if (count <= 0) { next.push(voice); continue; }
      voice.render(scratch, start, count);
      const { g, sends } = this.chanGains(voice.chanKey);
      if (g !== 0) {
        for (let i = start; i < N; i++) dry[i] += g * scratch[i];
        if (sends) {
          for (const f of fx) {
            if (!f.enabled) continue;
            const s = sends[f.id];
            if (s && s > 0) { const gs = g * s; const bus = f.bus; for (let i = start; i < N; i++) bus[i] += gs * scratch[i]; }
          }
        }
        const bank = this.symBanks.get(voice.chanKey);
        if (bank) { const inp = bank.input; for (let i = start; i < N; i++) inp[i] += g * scratch[i]; }
      }
      if (!voice.done) next.push(voice);
    }
    this.active = next;

    // sympathetic strings ring from each channel's signal, into the dry bus
    for (const bank of this.symBanks.values()) bank.flush(dry, N);

    // sanitize before the feedback FX: a runaway per-channel gain could otherwise
    // drive a reverb/delay comb to Inf, and Inf poisons its state forever (silence
    // that persists even after the gain is turned back down). Clamp to a finite
    // ceiling — extreme gain then just distorts instead of killing the engine.
    for (let i = 0; i < N; i++) dry[i] = clampFinite(dry[i]);
    for (const f of fx) { if (f.enabled) { const bus = f.bus; for (let i = 0; i < N; i++) bus[i] = clampFinite(bus[i]); } }

    // dynamic send FX -> widen to stereo. For EACH enabled instance: process its
    // send bus through its own processor(s), add the (mix-scaled) wet into L/R.
    const L = new Float32Array(N);
    const R = new Float32Array(N);
    L.set(dry); R.set(dry);
    for (const f of fx) {
      if (!f.enabled) continue;
      if (f.type === "reverb" && f.revL && f.revR) {
        const mix = numOr(f.params.mix, 0.25);
        f.revL.process(f.bus, f.wetL);
        f.revR.process(f.bus, f.wetR);
        for (let i = 0; i < N; i++) { L[i] += mix * clampFinite(f.wetL[i]); R[i] += mix * clampFinite(f.wetR[i]); }
      } else if (f.type === "delay" && f.ping) {
        f.ping.process(f.bus, f.wetL, f.wetR); // mix applied inside the delay
        for (let i = 0; i < N; i++) { L[i] += clampFinite(f.wetL[i]); R[i] += clampFinite(f.wetR[i]); }
      } else if (f.type === "chorus" && f.chorus) {
        const mix = numOr(f.params.mix, 0.5);
        f.chorus.process(f.bus, f.wetL, f.wetR);
        for (let i = 0; i < N; i++) { L[i] += mix * clampFinite(f.wetL[i]); R[i] += mix * clampFinite(f.wetR[i]); }
      }
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
      this.symBanks.clear(); // sympathetic banks may hold the poison; rebuild fresh
      this.comp = this.opts.compress ? new Compressor(this.opts.compress) : undefined;
      this.limiter = new Compressor(LIMITER);
      this.rebuildAllFx(); // any FX instance may hold the poison; rebuild them all
    }

    this.pos += N;
    return [L, R];
  }
}
