/**
 * Trivial additive sine synth for the parsed MIDI structure.
 *
 * Each note becomes a windowed sine tone; all tones are summed (additive
 * mixing) into one Float32 buffer, normalized, and written to a 16-bit WAV.
 * Optionally plays it via `aplay`.
 *
 * Run:  node synth.ts [file.mid] [--play] [--attack ms] [--release ms]
 *                      [--harmonics "3:0.3,5:0.15"] [--sine]
 */

import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseMidi, type Song, type Note } from "./midiParse.ts";
import { song as bundledSong } from "./songData.ts";
import { gmVoice, GM_NAMES } from "./gm.ts";
import { renderDrum } from "./drums.ts";

const SR = 44100; // sample rate
const DROP_DRUMS = true; // channel 9 = GM percussion; sine drums sound bad

const midiToHz = (pitch: number): number => 440 * 2 ** ((pitch - 69) / 12);

/** A harmonic partial: sine at `multiple`x the fundamental, at `amp` gain. */
export interface Harmonic {
  multiple: number;
  amp: number;
}

/**
 * 2-operator FM: a carrier sine phase-modulated by a modulator sine.
 *   out(t) = sin(wc·t + I(t)·sin(wm·t)),  wm = ratio·wc
 * The modulation index I decays over the note (I(t) = index·e^(−t/decay)),
 * so each note starts bright/metallic and mellows — the classic DX7 electric
 * piano / bell shimmer. `ratio` sets the timbre: integers -> harmonic/tonal,
 * non-integers -> clangy/bell-like.
 */
export interface FmConfig {
  ratio: number; // modulator freq / carrier freq
  index: number; // peak modulation depth
  decay: number; // seconds; time constant of the index decay
  sustain: number; // 0..1 fraction of index that remains after decay
  // sustain=0 -> decays to a pure tone (Rhodes/bell); sustain=1 -> steady spectrum (organ)
}

/**
 * Subtractive synthesis: a harmonically-rich, band-limited oscillator
 * (saw/square via polyBLEP anti-aliasing) shaped by a resonant low-pass
 * filter whose cutoff is swept by an envelope. `voices` detuned copies
 * (unison, spread by `detune` cents) fatten the tone. This is the classic
 * analog-synth engine — plucks, acid basses, string pads.
 */
export interface SubConfig {
  wave: "saw" | "square"; // oscillator shape
  cutoff: number; // base filter cutoff, Hz
  resonance: number; // 0..~1, filter emphasis at the cutoff
  envAmount: number; // Hz added to cutoff at note start
  envDecay: number; // seconds; how fast the cutoff falls back to base
  detune: number; // unison spread, cents
  voices: number; // unison oscillator count
  drive?: number; // waveshaping distortion (1 = clean; >1 crunches). tanh soft-clip pre-filter.
}

/**
 * Formant (vocal) synthesis: a buzzy saw "glottal" source is passed through a
 * bank of three resonant band-pass filters parked at the vowel formant peaks
 * F1/F2/F3. Their frequencies decide the vowel (a/e/i/o/u). `vowel` may be a
 * morph like "a>o", sweeping the formants across the note so it "talks".
 */
export interface FormantConfig {
  vowel: string; // "a".."u", or a morph "a>o"
  voices: number; // unison saws (choir thickness)
  detune: number; // unison spread, cents
}

/** Pitch LFO: sine wobble of `depth` cents at `rate` Hz. Applied to every engine. */
export interface Vibrato {
  rate: number; // Hz
  depth: number; // cents of peak deviation
}

/** Feedback delay (echo). */
export interface Delay {
  time: number; // seconds between taps
  feedback: number; // 0..1 regeneration
  mix: number; // 0..1 wet level
}

/** Cheap Schroeder reverb (4 combs + 2 allpasses). */
export interface Reverb {
  room: number; // 0..1 tail length
  mix: number; // 0..1 wet level
}

/**
 * Karplus–Strong plucked string (physical modeling): a delay line the length
 * of one period is filled with a noise burst, then repeatedly low-pass-filtered
 * and fed back. The noise decays into a pitched tone as a real string does —
 * no oscillator or spectrum specified, the sound emerges from the physics.
 */
export interface KsConfig {
  decay: number; // feedback gain 0..1; higher -> longer sustain
  damping: number; // 0..1 low-pass blend; higher -> darker, faster high-freq decay
  body?: number; // 0..~0.5 body resonance mix — the "wooden box" of an acoustic
  stiffness?: number; // 0..1 string stiffness -> inharmonicity (overtones stretch sharp).
  //   The single biggest "real string vs synth pluck" cue; pianos want a lot.
  pick?: number; // 0..0.5 pluck position along the string (fraction). Comb-filters the
  //   excitation: plucking near the bridge (small) is thin/bright, mid-string is round.
  tone?: number; // 0..1 pick hardness / excitation brightness. 1 = hard/bright (raw noise),
  //   lower = softer/darker (finger). Default 1 keeps the bare-string sound.
  strings?: number; // 1..3 detuned strings per note (piano/12-string/chorused). Each is its
  //   own KS delay line, summed -> beating/shimmer + a stronger attack. Default 1 = one string.
  spread?: number; // cents of detune across the `strings` (0 -> perfect unison, no beating).
  velBright?: number; // 0..1 velocity -> excitation brightness: a harder pluck is brighter (raises
  //   the effective pick `tone` with velocity). 0 = off (velocity only scales level, as before).
  releaseDamp?: number; // 0..1 extra damping applied over the note's release: a released string is
  //   choked (faster high-freq + amplitude decay) as a player mutes it. 0 = just fade out, as before.
  pluckNoise?: number; // 0..~0.5 short broadband pick/finger contact-noise transient at the attack.
  //   0 = clean (bare string). A little adds the "click" of a real pick/hammer touching the string.
  loopCut?: number; // Extended-KS loop loss filter cutoff, Hz (default off = no extra filter). A
  //   one-pole low-pass INSIDE the feedback loop: harmonics above it decay fast while the
  //   fundamental rings — the frequency-dependent damping of a real (esp. thick bass/wound) string.
  //   Low values (~800-1500) give a bright pluck that instantly settles to a round tone (kills "sitar").
}

/**
 * Sympathetic string resonance: a bank of tuned feedback combs (each a little
 * undamped "string") driven by the mix. Strings whose pitch matches energy in
 * the signal ring in sympathy — the shimmer of a piano with the pedal down or
 * a sitar's drones. Tuned to the song's own pitch classes so it stays in key.
 */
export interface Sympathetic {
  freqs: number[]; // resonator frequencies, Hz (tuned to the song)
  feedback: number; // 0..1 ring/decay time of each string
  damping: number; // 0..1 low-pass in the loop; lower -> darker, faster high decay
  mix: number; // 0..1 wet level
  couple: number; // 0..~0.1 energy bled between octave/fifth-related strings
}

/**
 * Per-instrument sympathetic resonance: the instrument's *own* undamped strings
 * (a guitar's six open strings, a piano's strings with the pedal down) ringing
 * along with what's played. Unlike `Sympathetic` (a global, song-tuned effect on
 * the whole mix), this is attached to one voice and driven only by that
 * instrument's signal, so each instrument rings with its own strings.
 */
export interface SympatheticVoice {
  strings: number[]; // MIDI pitches of the resonating strings (e.g. guitar open strings)
  feedback: number; // 0..1 ring/decay time
  damping: number; // 0..1 loop low-pass (lower -> brighter, longer high ring)
  mix: number; // wet level added to the instrument's dry signal
}

/**
 * Guitar amp + speaker-cabinet voicing — what makes a string read as a clean
 * *electric* guitar (vs. an acoustic pluck). A pickup/string is dry; the amp adds
 * a little tube soft-clip, a midrange presence bump, and — crucially — a speaker
 * cabinet's sharp high roll-off (a real cab dies above ~5 kHz). This is the stage
 * FL Slayer stacks on its string model that a bare Karplus-Strong lacks.
 */
export interface AmpConfig {
  drive: number; // 1 = clean; >1 = tube-ish soft-clip warmth
  presence: number; // 0..1 midrange presence bump (~2.2 kHz)
  cabLow: number; // cabinet low-pass cutoff Hz (~3500-5500) — the "speaker" sound
  level: number; // output makeup gain
}

export interface RenderOptions {
  attack: number; // seconds
  release: number; // seconds
  harmonics: Harmonic[]; // additive: extra partials added to the fundamental (1x @ 1.0)
  fm?: FmConfig; // if set, use FM instead of additive harmonics
  sub?: SubConfig; // if set, use subtractive (takes precedence over fm)
  formant?: FormantConfig; // if set, use formant/vocal (takes precedence over sub)
  ks?: KsConfig; // if set, use Karplus-Strong pluck (takes precedence over formant)
  vibrato?: Vibrato; // pitch LFO on all engines
  sympathetic?: Sympathetic; // tuned resonator bank (applied to dry, before delay/reverb)
  delay?: Delay; // post-mix echo
  reverb?: Reverb; // post-mix reverb
  gm?: boolean; // render each note with its GM-program voice (multi-instrument)
  drums?: boolean; // synthesize channel-10 percussion (see drums.ts)
  compress?: Compress; // master bus compression (glue; brings sustained parts up)
  voiceOverrides?: Record<string, VoiceOverride>; // per "track:channel" instrument/param edits
}

/** Master bus compressor: soft-knee, peak-detecting, stereo-linked. */
export interface Compress {
  threshold: number; // dB (e.g. -18)
  ratio: number; // e.g. 3 (3:1)
  attack: number; // seconds
  release: number; // seconds
}

/** Per-channel override: swap the GM program and/or tweak individual voice fields. */
export interface VoiceOverride {
  program?: number; // pick a different GM instrument for this channel
  gain?: number;
  attack?: number;
  release?: number;
  foldAbove?: number;
  harmonics?: Harmonic[];
  fm?: FmConfig;
  sub?: SubConfig;
  ks?: KsConfig;
  formant?: FormantConfig;
  sympathetic?: SympatheticVoice; // the instrument's own strings ringing in sympathy
  amp?: AmpConfig; // guitar amp + cabinet voicing (electric-guitar colour)
}

// Lip-radiation pre-emphasis for the formant/vocal engine. A real vocal chain is
// glottal source -> vocal-tract formants -> LIP RADIATION, and that last stage is
// a first-difference differentiator (+6 dB/oct). Our saw source + band-pass bank
// had NO radiation stage, so the output stayed F1-dominated and every vowel read
// dark/low/muddy — the ~3 kHz "singer's formant" region barely spoke. Applying the
// one-zero differentiator y = x - a·x[-1] to the source restores the upper-formant
// tilt so the voice sits in its expected bright, present register. FORMANT_PREEMPH
// is the differentiator coefficient; FORMANT_PREEMPH_MAKEUP compensates the level
// the differentiator removes (it strongly attenuates the low end). Exported so the
// streaming twin (web/streamingSynth.ts) uses byte-identical values.
export const FORMANT_PREEMPH = 0.75;
export const FORMANT_PREEMPH_MAKEUP = 3.71; // ~preserves the pre-fix output level (the differentiator strips the strong low end)

// Vowel formant table: [F1,F2,F3] Hz, matching gains, and bandwidths Hz.
// Values are typical for a sung voice; three peaks are enough to read as vowels.
export const VOWELS: Record<string, { f: number[]; g: number[]; bw: number[] }> = {
  a: { f: [800, 1150, 2900], g: [1.0, 0.5, 0.2], bw: [80, 90, 120] },
  e: { f: [400, 1600, 2700], g: [1.0, 0.4, 0.25], bw: [70, 100, 120] },
  i: { f: [350, 1700, 2700], g: [1.0, 0.3, 0.3], bw: [60, 100, 120] },
  o: { f: [450, 800, 2830], g: [1.0, 0.6, 0.2], bw: [70, 90, 120] },
  u: { f: [325, 700, 2530], g: [1.0, 0.5, 0.18], bw: [60, 90, 120] },
};

// The default "organ" voice: fundamental + a touch of 3rd/5th odd harmonics.
export const DEFAULT_OPTS: RenderOptions = {
  attack: 0.005,
  release: 0.03,
  harmonics: [
    { multiple: 3, amp: 0.3 },
    { multiple: 5, amp: 0.15 },
  ],
};

// Named FM voices. `sustain` is what separates a struck tone (decays to pure)
// from an organ (index holds -> steady, drawbar-like spectrum).
export const FM_VOICES: Record<string, FmConfig> = {
  rhodes: { ratio: 1, index: 4, decay: 0.8, sustain: 0 }, // struck e-piano, mellows
  organ: { ratio: 1, index: 0.4, decay: 0.05, sustain: 1 }, // steady, subtle warmth over a near-sine
  brass: { ratio: 1, index: 5, decay: 0.3, sustain: 0.6 }, // bright attack, stays present
  bell: { ratio: 1.4, index: 8, decay: 2, sustain: 0 }, // inharmonic chime
};
export const DEFAULT_FM: FmConfig = FM_VOICES.rhodes;

// Named subtractive voices.
export const SUB_VOICES: Record<string, SubConfig> = {
  pluck: { wave: "saw", cutoff: 300, resonance: 0.55, envAmount: 4000, envDecay: 0.18, detune: 0, voices: 1 },
  acid: { wave: "saw", cutoff: 220, resonance: 0.9, envAmount: 3200, envDecay: 0.28, detune: 0, voices: 1 },
  strings: { wave: "saw", cutoff: 1400, resonance: 0.15, envAmount: 1200, envDecay: 0.7, detune: 14, voices: 5 },
};
export const DEFAULT_SUB: SubConfig = SUB_VOICES.pluck;

// Named formant/vocal voices.
export const FORMANT_VOICES: Record<string, FormantConfig> = {
  vox: { vowel: "a", voices: 3, detune: 10 }, // a small "aah" ensemble
  choir: { vowel: "o", voices: 5, detune: 16 }, // fuller "ooh" choir
  talk: { vowel: "a>o", voices: 3, detune: 10 }, // morphs aah -> ooh across each note
};
export const DEFAULT_FORMANT: FormantConfig = FORMANT_VOICES.vox;

// Named Karplus-Strong voices.
export const KS_VOICES: Record<string, KsConfig> = {
  string: { decay: 0.996, damping: 0.5 }, // guitar/plucked string
  harp: { decay: 0.999, damping: 0.4 }, // longer, brighter ring
  mute: { decay: 0.985, damping: 0.7 }, // short, palm-muted / staccato
};
export const DEFAULT_KS: KsConfig = KS_VOICES.string;

/**
 * polyBLEP: a small correction subtracted around each discontinuity of a
 * naive saw/square so it stays (nearly) band-limited and doesn't alias.
 * `t` is the phase 0..1, `dt` the per-sample phase increment (freq/SR).
 */
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

/** Per-sample pitch multiplier from the vibrato LFO (1.0 when disabled). */
function vibFactor(vib: Vibrato | undefined, k: number): number {
  if (!vib) return 1;
  return 2 ** ((vib.depth / 1200) * Math.sin((2 * Math.PI * vib.rate * k) / SR));
}

/** Linear attack/release window so summed sines don't click. */
function applyEnvelope(tone: Float32Array, attack: number, release: number): void {
  const n = tone.length;
  const a = Math.min(Math.floor(attack * SR), n >> 1);
  const r = Math.min(Math.floor(release * SR), n >> 1);
  for (let k = 0; k < a; k++) tone[k] *= k / a;
  for (let k = 0; k < r; k++) tone[n - 1 - k] *= k / r;
}

/**
 * Fill `tone` with one subtractive-synth note: `voices` detuned band-limited
 * oscillators summed, then a resonant low-pass (Chamberlin state-variable
 * filter) whose cutoff starts at `cutoff + envAmount` and decays to `cutoff`.
 */
function renderSub(
  tone: Float32Array,
  sub: SubConfig,
  freq: number,
  amp: number,
  vib?: Vibrato,
): void {
  const n = tone.length;
  const nv = Math.max(1, Math.floor(sub.voices));
  const phases = new Float64Array(nv);
  const baseIncs = new Float64Array(nv); // per-voice phase increment (freq/SR)
  for (let v = 0; v < nv; v++) {
    const spread = nv > 1 ? v / (nv - 1) - 0.5 : 0; // -0.5..0.5
    baseIncs[v] = (freq * 2 ** ((spread * sub.detune) / 1200)) / SR;
    phases[v] = v / nv; // spread start phases for a wider sum
  }

  const square = sub.wave === "square";
  const drive = sub.drive ?? 1;
  const envDecaySamples = Math.max(sub.envDecay * SR, 1);
  const q1 = Math.max(2 * (1 - sub.resonance), 0.05); // damping; lower -> more resonant
  let low = 0;
  let band = 0;

  for (let k = 0; k < n; k++) {
    const vf = vibFactor(vib, k); // pitch LFO
    // --- band-limited oscillator sum (unison) ---
    let s = 0;
    for (let v = 0; v < nv; v++) {
      const dt = baseIncs[v] * vf;
      let ph = phases[v];
      let val: number;
      if (square) {
        val = ph < 0.5 ? 1 : -1;
        val += polyBlep(ph, dt) - polyBlep((ph + 0.5) % 1, dt);
      } else {
        val = 2 * ph - 1 - polyBlep(ph, dt); // saw
      }
      s += val;
      ph += dt;
      if (ph >= 1) ph -= 1;
      phases[v] = ph;
    }
    s /= nv;

    // --- distortion: tanh soft-clip BEFORE the filter, like a guitar amp
    // (preamp overdrive -> the filter then acts as the speaker cabinet, taming
    // the harsh top). drive 1 is clean; higher folds the saw into a fuzz. ---
    if (drive > 1) { const d = s * drive + 0.2; const c = d <= -1 ? -1 : d >= 1 ? 1 : 1.5 * d - 0.5 * d * d * d; s = c - 0.16; } // cubic soft-clip: harder edge than tanh -> audible grit

    // --- resonant low-pass with envelope-swept cutoff ---
    let fc = sub.cutoff + sub.envAmount * Math.exp(-k / envDecaySamples);
    if (fc > SR / 6) fc = SR / 6; // Chamberlin stability limit
    if (fc < 20) fc = 20;
    const f = 2 * Math.sin((Math.PI * fc) / SR);
    low += f * band;
    const high = s - low - q1 * band;
    band += f * high;
    if (!Number.isFinite(low) || !Number.isFinite(band)) { low = 0; band = 0; } // self-heal a rung-up filter

    tone[k] = low * amp;
  }
}

/**
 * Fill `tone` with one formant/vocal note: a unison saw source through three
 * RBJ band-pass biquads at the vowel's F1/F2/F3. If `vowel` is a morph "x>y",
 * the formant targets are linearly interpolated from x to y across the note.
 */
function renderFormant(
  tone: Float32Array,
  cfg: FormantConfig,
  freq: number,
  amp: number,
  vib?: Vibrato,
): void {
  const n = tone.length;
  const [va, vb] = cfg.vowel.split(">");
  const A = VOWELS[va] ?? VOWELS.a;
  const B = VOWELS[vb ?? va] ?? A; // no ">" -> static vowel (B === A)
  const morph = B !== A;

  // unison saw source
  const nv = Math.max(1, Math.floor(cfg.voices));
  const phases = new Float64Array(nv);
  const baseIncs = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    const spread = nv > 1 ? v / (nv - 1) - 0.5 : 0;
    baseIncs[v] = (freq * 2 ** ((spread * cfg.detune) / 1200)) / SR;
    phases[v] = v / nv;
  }

  // three biquad band-pass states (x/y history per formant)
  const x1 = [0, 0, 0];
  const x2 = [0, 0, 0];
  const y1 = [0, 0, 0];
  const y2 = [0, 0, 0];
  // precomputed static coeffs (used when not morphing)
  const co = [0, 1, 2].map((i) => bandpass(A.f[i], A.f[i] / A.bw[i]));
  let prevS = 0; // lip-radiation differentiator state

  for (let k = 0; k < n; k++) {
    const vf = vibFactor(vib, k); // pitch LFO
    // --- source: band-limited saw sum ---
    let s = 0;
    for (let v = 0; v < nv; v++) {
      const dt = baseIncs[v] * vf;
      let ph = phases[v];
      s += 2 * ph - 1 - polyBlep(ph, dt);
      ph += dt;
      if (ph >= 1) ph -= 1;
      phases[v] = ph;
    }
    s /= nv;
    // lip-radiation pre-emphasis (see FORMANT_PREEMPH): +6 dB/oct tilt so the
    // upper formants speak and the vowel reads bright/present, not dark/low.
    { const d = s - FORMANT_PREEMPH * prevS; prevS = s; s = d * FORMANT_PREEMPH_MAKEUP; }

    // --- formant band-pass bank ---
    const t = morph ? k / n : 0;
    let out = 0;
    for (let i = 0; i < 3; i++) {
      const c = morph
        ? bandpass(A.f[i] + (B.f[i] - A.f[i]) * t, /*Q*/ (A.f[i] + (B.f[i] - A.f[i]) * t) / A.bw[i])
        : co[i];
      const y =
        c.b0 * s + c.b1 * x1[i] + c.b2 * x2[i] - c.a1 * y1[i] - c.a2 * y2[i];
      x2[i] = x1[i];
      x1[i] = s;
      y2[i] = y1[i];
      y1[i] = y;
      const g = morph ? A.g[i] + (B.g[i] - A.g[i]) * t : A.g[i];
      out += g * y;
    }
    tone[k] = out * amp;
  }
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ band-pass (constant 0 dB peak) biquad coeffs, normalized by a0. */
function bandpass(f: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f) / SR;
  const alpha = Math.sin(w0) / (2 * Math.max(q, 0.1));
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w0)) / a0,
    a2: (1 - alpha) / a0,
  };
}

// A guitar body's resonant modes (Hz, Q, relative gain): the Helmholtz air
// resonance, the main top-plate mode, and a spread of higher body/plate modes.
// Summed as a resonator bank this is a modal body — the same set of resonances a
// measured body impulse response is built from — far richer than two band-passes.
export const BODY_MODES: { f: number; q: number; g: number }[] = [
  { f: 100, q: 6, g: 1.0 },
  { f: 200, q: 7, g: 0.8 },
  { f: 280, q: 8, g: 0.5 },
  { f: 400, q: 8, g: 0.45 },
  { f: 540, q: 9, g: 0.35 },
  { f: 700, q: 10, g: 0.3 },
  { f: 900, q: 10, g: 0.25 },
  { f: 1200, q: 11, g: 0.2 },
  { f: 1700, q: 12, g: 0.15 },
  { f: 2400, q: 12, g: 0.12 },
];
export const BODY_NORM = 0.5; // keeps the summed bank in the same level range as the old 2-band body

/**
 * Phase delay (in samples) of a first-order all-pass H(z) = (a + z⁻¹)/(1 + a z⁻¹)
 * at angular frequency w. Used to compensate the delay-line length so adding the
 * dispersion all-pass (for string stiffness) doesn't detune the note.
 */
export function allpassPhaseDelay(a: number, w: number): number {
  if (w <= 0) return 0;
  const s = Math.sin(w), c = Math.cos(w);
  const phase = Math.atan2(-s, a + c) - Math.atan2(-a * s, 1 + a * c);
  return -phase / w;
}

/** Phase delay (samples) at w of a one-pole low-pass y = A·x + (1-A)·y[-1]. Used to
 *  compensate the delay-line length for the Extended-KS loop loss filter. */
export function onepolePhaseDelay(A: number, w: number): number {
  if (w <= 0 || A >= 1) return 0;
  return Math.atan2((1 - A) * Math.sin(w), 1 - (1 - A) * Math.cos(w)) / w;
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
/** One biquad's stateful sample step (Direct Form I). `s` = [x1,x2,y1,y2]. */
function biquadStep(cf: Biquad, s: Float64Array, x: number): number {
  const y = cf.b0 * x + cf.b1 * s[0] + cf.b2 * s[1] - cf.a1 * s[2] - cf.a2 * s[3];
  s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
  return y;
}

/**
 * Guitar amp + speaker-cabinet voicing applied in place over an enveloped buffer:
 * high-pass (kill rumble) -> tube-ish soft clip -> midrange presence peak ->
 * cabinet low-pass -> makeup level. Byte-for-byte the same chain as streamingSynth's
 * AmpStage, so an offline render matches the live/streaming render for the same voice.
 * All params are clamped finite so a stray value can never poison the biquad state.
 */
function applyAmp(tone: Float32Array, cfg: AmpConfig): void {
  const presence = Number.isFinite(cfg.presence) ? Math.min(Math.max(cfg.presence, 0), 1) : 0;
  const cabLow = Number.isFinite(cfg.cabLow) ? Math.min(Math.max(cfg.cabLow, 200), 20000) : 20000;
  const drive = Number.isFinite(cfg.drive) ? Math.max(1, cfg.drive) : 1;
  const level = Number.isFinite(cfg.level) ? Math.min(Math.max(cfg.level, 0), 4) : 1;
  const driveNorm = 1 / Math.tanh(drive);
  const pk = peaking(2200, 1.0, 5 * presence);
  const lp = lowpass(cabLow, 0.7);
  const pkS = new Float64Array(4), lpS = new Float64Array(4);
  const hpA = 1 - Math.exp((-2 * Math.PI * 90) / SR);
  let hpLp = 0;
  for (let i = 0; i < tone.length; i++) {
    let x = tone[i];
    hpLp += hpA * (x - hpLp); x = x - hpLp; // high-pass
    x = Math.tanh(x * drive) * driveNorm; // tube-ish soft clip
    x = biquadStep(pk, pkS, x); // presence
    x = biquadStep(lp, lpS, x); // cabinet roll-off
    x *= level;
    tone[i] = Number.isFinite(x) ? x : 0;
  }
}

export interface KsSetup {
  Li: number; // integer delay-line length
  C: number; // tuning all-pass coefficient (fractional delay, accurate pitch)
  disp: number; // dispersion all-pass coefficient (string stiffness / inharmonicity)
  b: number; // damping (loop low-pass blend)
  decay: number; // feedback gain
  lpA: number; // Extended-KS loop loss one-pole coefficient (1 = off; <1 damps highs in the loop)
}

/**
 * Resolve a string's delay-line geometry. A plain KS uses round(SR/freq), which
 * quantises pitch (audibly "off"/synthetic on high notes) and can't be stiff.
 * Here the loop delay is split into an integer line + a fractional tuning
 * all-pass (accurate pitch) plus an optional dispersion all-pass whose extra
 * delay is subtracted out so stiffness changes timbre, not tuning.
 */
export function ksStringSetup(freq: number, ks: KsConfig): KsSetup {
  const w0 = (2 * Math.PI * freq) / SR;
  const disp = 0.5 * Math.min(Math.max(ks.stiffness ?? 0, 0), 1); // 0..0.5 (sharpens high partials)
  const pdDisp = disp !== 0 ? allpassPhaseDelay(disp, w0) : 1; // disp=0 ⇒ z⁻¹ (1 samp)
  // Damping is a 2-point loop averager (1-b)·x[n] + b·x[n-1]. Its high-frequency
  // roll-off is MONOTONIC only for b ∈ [0, 0.5]: at b=0.5 it puts a zero at Nyquist
  // (maximally dark); for b>0.5 the Nyquist gain (1-2b)² RISES again, i.e. the string
  // gets BRIGHTER. So we map the documented 0..1 "damping" knob onto the usable
  // [0, 0.5] half — higher is now always darker. (Passing b straight through, as the
  // code used to, meant damping>0.5 paradoxically re-brightened, and every guitar
  // preset clustered around the same tone regardless of its damping value.)
  const dRaw = Number.isFinite(ks.damping) ? Math.min(Math.max(ks.damping, 0), 1) : 0.5;
  const bEff = 0.5 * dRaw;
  const DAMP_DELAY = bEff; // the averager's group delay ≈ bEff samples (keeps tuning exact)
  // Extended-KS loop loss filter: a one-pole low-pass in the loop so highs decay
  // fast (frequency-dependent damping of a real string). Compensate its phase
  // delay so it darkens the tone without detuning the note.
  const loopCut = Number.isFinite(ks.loopCut) ? (ks.loopCut as number) : 20000;
  const lpA = loopCut < SR * 0.45 ? 1 - Math.exp((-2 * Math.PI * loopCut) / SR) : 1;
  const pdLP = lpA < 1 ? onepolePhaseDelay(lpA, w0) : 0;
  const target = SR / freq - pdDisp - DAMP_DELAY - pdLP;
  let Li = Math.floor(target);
  if (Li < 2) Li = 2;
  let frac = target - Li;
  if (frac < 0) frac = 0;
  else if (frac > 1) frac = 1;
  const C = (1 - frac) / (1 + frac); // first-order fractional-delay all-pass
  // Guard decay: a non-finite feedback gain would latch the whole loop to NaN.
  const decay = Number.isFinite(ks.decay) ? Math.min(Math.max(ks.decay, 0), 1) : 0.996;
  return { Li, C, disp, b: bEff, decay, lpA };
}

/**
 * Build a plucked-string excitation of length L: white noise shaped by pick
 * hardness (`tone`: a low-pass — softer = darker) and pluck position (`pick`:
 * a comb that nulls the harmonic with a node at the pick point, the way a real
 * string plucked at 1/5 sounds different from one plucked at the bridge).
 */
export function seedString(L: number, pick: number, tone: number): Float32Array {
  const seed = new Float32Array(L);
  for (let i = 0; i < L; i++) seed[i] = Math.random() * 2 - 1;
  const a = 1 - Math.min(Math.max(tone, 0), 1); // tone 1 -> a 0 (bright/raw)
  if (a > 0) {
    let lp = 0;
    for (let i = 0; i < L; i++) { lp = seed[i] + a * (lp - seed[i]); seed[i] = lp; }
    // The low-pass removes energy, so a softer/darker pick was audibly QUIETER.
    // Rescale to the raw white-noise RMS so `tone` changes timbre, not loudness.
    let ss = 0;
    for (let i = 0; i < L; i++) ss += seed[i] * seed[i];
    const rms = Math.sqrt(ss / L);
    if (rms > 1e-6) { const g = 0.5774 / rms; for (let i = 0; i < L; i++) seed[i] *= g; }
  }
  // Pick-position comb (applied AFTER the energy normalization): plucking near the
  // bridge legitimately thins/quietens the tone, so this is left to affect level.
  const pd = Math.round(Math.min(Math.max(pick, 0), 0.5) * L);
  if (pd > 0 && pd < L) { const cp = seed.slice(); for (let i = 0; i < L; i++) seed[i] = cp[i] - (i >= pd ? cp[i - pd] : 0); }
  return seed;
}

/**
 * Fill `tone` with one plucked/struck string. An extended Karplus-Strong: a
 * noise-seeded delay line with a damping low-pass and decay feedback, plus a
 * dispersion all-pass (stiffness → stretched, inharmonic overtones) and a
 * fractional-delay all-pass (accurate pitch), tapped through the body resonators.
 */
function renderKs(
  tone: Float32Array,
  ks: KsConfig,
  freq: number,
  amp: number,
  vel = 1, // normalized note velocity 0..1 (drives velBright)
  relSamples = 0, // length of the note's release window in samples (drives releaseDamp)
): void {
  const n = tone.length;
  // velocity -> brightness: a harder pluck raises the effective pick `tone` (brighter seed).
  const velBright = Math.min(Math.max(ks.velBright ?? 0, 0), 1);
  const effTone = Math.min(Math.max((ks.tone ?? 1) + velBright * (vel - 0.5), 0), 1);
  // multi-string unison: `ns` detuned strings summed -> beating/shimmer & a fuller attack.
  const ns = Math.min(Math.max(Math.floor(ks.strings ?? 1), 1), 3);
  const spread = ks.spread ?? 0;
  const norm = 1 / Math.sqrt(ns); // partially-incoherent sum: ns=1 -> 1 (no change)
  const lines: Float32Array[] = [];
  const Li = new Int32Array(ns), disp = new Float64Array(ns), C = new Float64Array(ns), idx = new Int32Array(ns);
  const dX1 = new Float64Array(ns), dY1 = new Float64Array(ns), tX1 = new Float64Array(ns), tY1 = new Float64Array(ns), dampPrev = new Float64Array(ns);
  const lpState = new Float64Array(ns); // Extended-KS loop loss filter state per string
  let b = 0, decay = 1, lpA = 1;
  for (let s = 0; s < ns; s++) {
    const cents = ns > 1 ? (s / (ns - 1) - 0.5) * spread : 0;
    const setup = ksStringSetup(freq * 2 ** (cents / 1200), ks);
    Li[s] = setup.Li; disp[s] = setup.disp; C[s] = setup.C; b = setup.b; decay = setup.decay; lpA = setup.lpA;
    lines[s] = seedString(setup.Li, ks.pick ?? 0, effTone);
  }
  // Pre-darken the excitation to the loop's HF-damping cutoff so the initial
  // delay-line readout isn't a bright NOISE BURST — a smooth fingered attack for
  // heavily-damped strings (bass). Re-normalize energy so the note stays full.
  if (lpA < 1) {
    const fadeN = Math.min(Math.floor(0.003 * SR), 256); // ~3ms raised-cosine fade-in -> no onset click
    for (let s = 0; s < ns; s++) {
      const seed = lines[s]; let lp = 0, ss = 0;
      for (let i = 0; i < seed.length; i++) { lp += lpA * (seed[i] - lp); seed[i] = lp; ss += lp * lp; }
      const rms = Math.sqrt(ss / seed.length);
      const g = rms > 1e-6 ? 0.5774 / rms : 1;
      const fN = Math.min(fadeN, seed.length >> 1);
      for (let i = 0; i < seed.length; i++) { let x = seed[i] * g; if (i < fN) x *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fN); seed[i] = x; }
    }
  }
  const body = ks.body ?? 0;
  // modal body: one band-pass per body mode, summed (a resonator-bank "body IR")
  const bodyC = body > 0 ? BODY_MODES.map((m) => ({ ...bandpass(m.f, m.q), g: m.g })) : [];
  const bst = new Float64Array(bodyC.length * 4); // [x1,x2,y1,y2] per mode
  // release damping: over the last `relSamples` the string is choked (b->1, decay drops).
  const relDamp = Math.min(Math.max(ks.releaseDamp ?? 0, 0), 1);
  const relStart = relDamp > 0 && relSamples > 0 ? n - relSamples : n;
  const pluckNoise = Math.min(Math.max(ks.pluckNoise ?? 0, 0), 1);
  const noiseLen = pluckNoise > 0 ? Math.floor(0.006 * SR) : 0; // ~6 ms contact transient
  const noiseTau = 0.0015 * SR;
  for (let k = 0; k < n; k++) {
    // release damping ramp: 0 while held, rising to relDamp across the release window
    let bK = b, decayK = decay;
    if (k >= relStart) {
      const rt = (k - relStart) / Math.max(relSamples, 1);
      bK = b + (0.5 - b) * relDamp * rt; // ramp toward b=0.5 (the averager's darkest), not 1 (which re-brightens)
      decayK = decay * (1 - 0.5 * relDamp * rt);
    }
    let mix = 0;
    for (let s = 0; s < ns; s++) {
      const line = lines[s];
      const cur = line[idx[s]]; // string output = the delayed sample
      // feedback chain: dispersion all-pass -> tuning all-pass -> damping -> decay
      const dOut = disp[s] * cur + dX1[s] - disp[s] * dY1[s]; dX1[s] = cur; dY1[s] = dOut;
      const tOut = C[s] * dOut + tX1[s] - C[s] * tY1[s]; tX1[s] = dOut; tY1[s] = tOut;
      let lp = (1 - bK) * tOut + bK * dampPrev[s]; dampPrev[s] = tOut;
      if (lpA < 1) { lpState[s] += lpA * (lp - lpState[s]); lp = lpState[s]; } // Extended-KS loop loss: highs decay fast
      let fb = lp * decayK;
      if (!Number.isFinite(fb)) fb = 0; // self-heal: never let the loop latch to NaN
      line[idx[s]] = fb;
      idx[s] = idx[s] + 1 === Li[s] ? 0 : idx[s] + 1;
      mix += cur;
    }
    mix *= norm;
    let out = mix;
    if (body > 0) {
      let bsum = 0;
      for (let m = 0; m < bodyC.length; m++) {
        const c = bodyC[m], o = m * 4;
        const y = c.b0 * mix + c.b1 * bst[o] + c.b2 * bst[o + 1] - c.a1 * bst[o + 2] - c.a2 * bst[o + 3];
        bst[o + 1] = bst[o]; bst[o] = mix; bst[o + 3] = bst[o + 2]; bst[o + 2] = y;
        bsum += c.g * y;
      }
      out = mix + body * BODY_NORM * bsum;
    }
    // pick/finger contact noise: a short bright broadband transient at the attack
    if (k < noiseLen) out += (Math.random() * 2 - 1) * pluckNoise * Math.exp(-k / noiseTau);
    tone[k] = out * amp;
  }
}

/** The timbre part of a render: engine + params (a subset of RenderOptions). */
export interface Voice {
  attack: number;
  release: number;
  gain?: number; // per-voice level (default 1)
  foldAbove?: number; // fold notes above this MIDI pitch down an octave (organ descants)
  harmonics?: Harmonic[];
  fm?: FmConfig;
  sub?: SubConfig;
  ks?: KsConfig;
  formant?: FormantConfig;
  sympathetic?: SympatheticVoice; // the instrument's own strings ringing in sympathy
  amp?: AmpConfig; // guitar amp + cabinet voicing (electric-guitar colour)
}

/** Synthesize one note's tone (n samples) with a given voice. */
function renderTone(
  n: number,
  freq: number,
  amp: number,
  v: Voice,
  vibrato: Vibrato | undefined,
  vel = 1, // normalized note velocity 0..1 (KS velBright)
): Float32Array {
  const inc0 = freq / SR;
  const tone = new Float32Array(n);
  if (v.ks) {
    // release window matches applyEnvelope's, so KS release-damping lines up with the fade
    const rel = Math.min(Math.floor(v.release * SR), n >> 1);
    renderKs(tone, v.ks, freq, amp, vel, rel);
  } else if (v.formant) {
    renderFormant(tone, v.formant, freq, amp, vibrato);
  } else if (v.sub) {
    renderSub(tone, v.sub, freq, amp, vibrato);
  } else if (v.fm) {
    const fm = v.fm;
    const decaySamples = Math.max(fm.decay * SR, 1);
    let pc = 0;
    let pm = 0;
    for (let k = 0; k < n; k++) {
      const env = fm.sustain + (1 - fm.sustain) * Math.exp(-k / decaySamples);
      const index = fm.index * env;
      tone[k] = Math.sin(2 * Math.PI * pc + index * Math.sin(2 * Math.PI * pm)) * amp;
      const inc = inc0 * vibFactor(vibrato, k);
      pc += inc;
      pm += inc * fm.ratio;
    }
  } else {
    const harmonics = v.harmonics ?? [];
    let ph = 0;
    for (let k = 0; k < n; k++) {
      let s = Math.sin(2 * Math.PI * ph);
      for (const h of harmonics) s += h.amp * Math.sin(2 * Math.PI * h.multiple * ph);
      tone[k] = s * amp;
      ph += inc0 * vibFactor(vibrato, k);
    }
  }
  applyEnvelope(tone, v.attack, v.release);
  // guitar amp + cabinet voicing (electric colour) — mirrors streaming AmpStage so
  // offline == streaming for the same voice; also sanitizes any stray non-finite sample.
  if (v.amp) applyAmp(tone, v.amp);
  return tone;
}

/**
 * Build the dry mono mix. `voiceFor` (optional) picks a Voice per note — used to
 * render a multi-instrument arrangement where each track has its own GM voice.
 * Without it every note uses the single voice in `opts`.
 */
function renderDry(song: Song, opts: RenderOptions, voiceFor?: (note: Note) => Voice): Float32Array {
  const total = Math.floor((song.duration + 0.5) * SR);
  const buf = new Float32Array(total);
  const base: Voice = opts; // RenderOptions is a superset of Voice

  for (const note of song.notes) {
    if (note.channel === 9) {
      // channel 10 is GM percussion — synthesized, not pitched (see drums.ts)
      if (!opts.drums) continue;
      const tone = renderDrum(note.pitch, note.velocity);
      const start = Math.floor(note.start * SR);
      for (let k = 0; k < tone.length && start + k < buf.length; k++) buf[start + k] += tone[k];
      continue;
    }
    const n = Math.max(Math.floor(note.dur * SR), 1);
    const v = voiceFor ? voiceFor(note) : base;
    // fold implausibly-high notes down an octave (organ descants are often
    // transcribed an octave too high and end up shrill/dominant)
    let pitch = note.pitch;
    if (v.foldAbove) while (pitch > v.foldAbove) pitch -= 12;
    const freq = midiToHz(pitch);
    const amp = (note.velocity / 127) ** 1.5 * 0.25 * (v.gain ?? 1);

    const tone = renderTone(n, freq, amp, v, opts.vibrato, note.velocity / 127);
    const start = Math.floor(note.start * SR);
    for (let k = 0; k < n; k++) buf[start + k] += tone[k]; // <-- additive mixing
  }
  return buf;
}

/**
 * One static, purely-linear master gain (no limiter -> no distortion/pumping):
 * aim for the dry melody at 0.9 peak, but back off if the full processed mix
 * (with effect tails) would clip. `dry` sets the target, `mixPeak` is the peak
 * of the finished signal.
 */
function masterGain(dry: Float32Array, mixPeak: number): number {
  const dryPeak = peakOf(dry);
  const target = dryPeak > 0 ? 0.9 / dryPeak : 1; // melody at 0.9...
  const clipSafe = mixPeak > 0 ? 0.99 / mixPeak : Infinity; // ...unless that clips
  return Math.min(target, clipSafe);
}

/**
 * Resolve each note's GM voice from the song's program-change events: the
 * program in effect for that note's (track, channel) at its start time. Tracks
 * with no program default to 0 (Acoustic Grand).
 */
export function gmVoiceFor(song: Song, overrides?: Record<string, VoiceOverride>): (note: Note) => Voice {
  const cache = new Map<string, Voice>();
  return (note: Note): Voice => {
    // program in effect for this (track, channel) at the note's start
    let prog = 0;
    let best = -1;
    for (const p of song.programs) {
      if (p.track === note.track && p.channel === note.channel && p.time <= note.start + 1e-6 && p.time >= best) {
        best = p.time;
        prog = p.program;
      }
    }
    const key = `${note.track}:${note.channel}`;
    const ov = overrides?.[key];
    const cacheKey = `${prog}|${key}`;
    let v = cache.get(cacheKey);
    if (!v) {
      v = gmVoice(ov?.program ?? prog);
      if (ov) {
        // merge only the fields the override actually sets; an override that
        // swaps the engine (e.g. sets `fm`) must clear the others.
        const engineKeys: (keyof VoiceOverride)[] = ["harmonics", "fm", "sub", "ks", "formant"];
        if (engineKeys.some((k) => ov[k] !== undefined)) {
          v = { attack: v.attack, release: v.release, gain: v.gain, foldAbove: v.foldAbove, sympathetic: v.sympathetic, amp: v.amp };
        }
        v = { ...v, ...ov };
      }
      cache.set(cacheKey, v);
    }
    return v;
  };
}

/**
 * Master bus compressor — soft-knee, peak-detecting, stereo-linked. Stateful, so
 * the same instance works for a whole offline buffer or block-by-block streaming.
 * Brings sustained instruments up under the drum transients (the "produced" glue
 * a dry mix lacks), unlike the melody-vs-drums imbalance of raw peak normalizing.
 */
export class Compressor {
  private envDb = 0; // current gain reduction envelope, dB
  private readonly thr: number;
  private readonly slope: number; // 1 - 1/ratio
  private readonly aA: number;
  private readonly aR: number;
  private readonly knee = 6; // dB soft knee width

  constructor(c: Compress) {
    this.thr = c.threshold;
    this.slope = 1 - 1 / Math.max(c.ratio, 1);
    this.aA = 1 - Math.exp(-1 / (Math.max(c.attack, 1e-4) * SR));
    this.aR = 1 - Math.exp(-1 / (Math.max(c.release, 1e-4) * SR));
  }

  /** Compress a single buffer in place. */
  processMono(buf: Float32Array): void {
    for (let k = 0; k < buf.length; k++) {
      buf[k] = this.step(buf[k], Math.abs(buf[k]));
    }
  }

  /** One sample: apply the current gain to `sample`, driven by detector level `x`. */
  private step(sample: number, x: number): number {
    if (!Number.isFinite(x)) x = 0; // an Inf/NaN detector must not poison the envelope
    const xdb = 20 * Math.log10(x + 1e-9);
    const over = xdb - this.thr;
    let targetGr: number;
    if (over <= -this.knee / 2) targetGr = 0;
    else if (over >= this.knee / 2) targetGr = over * this.slope;
    else {
      const t = (over + this.knee / 2) / this.knee;
      targetGr = t * t * (over + this.knee / 2) * this.slope;
    }
    const a = targetGr > this.envDb ? this.aA : this.aR;
    this.envDb += a * (targetGr - this.envDb);
    if (!Number.isFinite(this.envDb)) this.envDb = 0; // recover if it ever blew up
    return sample * 10 ** (-this.envDb / 20);
  }

  /** Compress `left`/`right` in place (stereo-linked detector). */
  processStereo(left: Float32Array, right: Float32Array): void {
    for (let k = 0; k < left.length; k++) {
      const x = Math.max(Math.abs(left[k]), Math.abs(right[k]));
      const g = this.step(1, x); // gain for this sample
      left[k] *= g;
      right[k] *= g;
    }
  }
}

/** Voice resolver for a render: GM (with per-channel overrides) or the single opts voice. */
function voiceResolver(song: Song, opts: RenderOptions): ((n: Note) => Voice) | undefined {
  return opts.gm ? gmVoiceFor(song, opts.voiceOverrides) : undefined;
}

/** Mono render: dry mix -> sympathetic -> delay -> reverb -> compress, then one gain. */
export function render(song: Song, opts: RenderOptions = DEFAULT_OPTS): Float32Array {
  const dry = renderDry(song, opts, voiceResolver(song, opts));
  let out = dry;
  if (opts.sympathetic) out = addSympathetic(out, opts.sympathetic);
  if (opts.delay) out = applyDelay(out, opts.delay);
  if (opts.reverb) out = applyReverb(out, opts.reverb, 0);
  if (opts.compress) new Compressor(opts.compress).processMono(out);
  const g = masterGain(dry, peakOf(out));
  for (let k = 0; k < out.length; k++) out[k] *= g;
  return out;
}

/**
 * Stereo render. The dry mix is centered; a ping-pong delay bounces echoes
 * L<->R, and the reverb uses decorrelated L/R comb lengths for width.
 * Returns [left, right].
 */
export function renderStereo(song: Song, opts: RenderOptions = DEFAULT_OPTS): [Float32Array, Float32Array] {
  const dryMono = renderDry(song, opts, voiceResolver(song, opts));
  let dry = dryMono;
  if (opts.sympathetic) dry = addSympathetic(dry, opts.sympathetic);
  let L = Float32Array.from(dry);
  let R = Float32Array.from(dry);

  if (opts.delay) {
    [L, R] = applyPingPong(dry, opts.delay);
  }
  if (opts.reverb) {
    L = applyReverb(L, opts.reverb, 0); // seed 0
    R = applyReverb(R, opts.reverb, 7); // seed 7 -> different comb lengths
  }
  if (opts.compress) new Compressor(opts.compress).processStereo(L, R);
  const g = masterGain(dryMono, Math.max(peakOf(L), peakOf(R)));
  for (let k = 0; k < L.length; k++) L[k] *= g;
  for (let k = 0; k < R.length; k++) R[k] *= g;
  return [L, R];
}

/** Stereo ping-pong delay: echoes alternate channels, regenerating at feedback. */
function applyPingPong(dry: Float32Array, d: Delay): [Float32Array, Float32Array] {
  const D = Math.max(1, Math.floor(d.time * SR));
  const lineL = new Float32Array(dry.length);
  const lineR = new Float32Array(dry.length);
  const outL = Float32Array.from(dry);
  const outR = Float32Array.from(dry);
  for (let k = 0; k < dry.length; k++) {
    const echoL = k >= D ? lineL[k - D] : 0;
    const echoR = k >= D ? lineR[k - D] : 0;
    lineL[k] = dry[k] + d.feedback * echoR; // right feeds back into left
    lineR[k] = d.feedback * echoL; // left bounces to right
    outL[k] = dry[k] + d.mix * echoL;
    outR[k] = dry[k] + d.mix * echoR;
  }
  return [outL, outR];
}

/**
 * Sympathetic resonance: a bank of tuned feedback-comb "strings", run
 * sample-major so they can interact. Two physical touches:
 *  - Excitation coupling: strings are driven by the signal's *transients*
 *    (an onset gate = fast envelope minus slow envelope), not the sustained
 *    tone — a real string is set going by the attack, then rings on its own.
 *  - String coupling: each string bleeds a little energy into its octave- and
 *    fifth-related neighbours (bridge coupling), so playing one wakes its
 *    harmonic partners.
 * Returns the wet signal (summed strings only) — the caller balances it
 * against the dry level, so ring length is set by feedback/couple while the
 * wet/dry *loudness* stays fixed by `mix`.
 */
function sympatheticWet(buf: Float32Array, s: Sympathetic): Float32Array {
  const N = s.freqs.length;
  const wetOut = new Float32Array(buf.length);
  if (N === 0) return wetOut;

  // per-string state
  const lines = s.freqs.map((f) => new Float32Array(Math.max(2, Math.round(SR / f))));
  const idx = new Int32Array(N);
  const lp = new Float64Array(N);
  const prevOut = new Float64Array(N);
  const curOut = new Float64Array(N);

  // coupling map: strings an octave (±12) or fifth (±7) apart, by pitch
  const semis = s.freqs.map((f) => Math.round(12 * Math.log2(f / s.freqs[0])));
  const coupled: number[][] = s.freqs.map(() => []);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const d = Math.abs(semis[i] - semis[j]);
      if (d === 12 || d === 7) coupled[i].push(j); // octave or perfect fifth
    }

  const drive = 1.2 / Math.sqrt(N); // boosted: the onset gate removes most energy
  // onset-gate envelope-follower coefficients (fast ~2ms, slow ~60ms)
  const cf = 1 - Math.exp(-1 / (0.002 * SR));
  const cs = 1 - Math.exp(-1 / (0.06 * SR));
  let envFast = 0;
  let envSlow = 0;

  for (let k = 0; k < buf.length; k++) {
    const x = buf[k];
    const a = Math.abs(x);
    envFast += cf * (a - envFast);
    envSlow += cs * (a - envSlow);
    const gate = Math.max(0, envFast - envSlow); // rising edge = note onset
    const exc = x * (0.1 + gate * 6); // mostly-transient excitation

    let wet = 0;
    for (let i = 0; i < N; i++) {
      const line = lines[i];
      const p = idx[i];
      const yD = line[p]; // one period ago
      lp[i] += s.damping * (yD - lp[i]); // string damping (low-pass)
      let couple = 0;
      const nb = coupled[i];
      for (let c = 0; c < nb.length; c++) couple += prevOut[nb[c]];
      // tanh soft-limit: a real string saturates rather than diverging, which
      // also keeps the coupled feedback network unconditionally stable.
      const y = Math.tanh(exc * drive + s.feedback * lp[i] + s.couple * couple);
      line[p] = y;
      idx[i] = p + 1 === line.length ? 0 : p + 1;
      curOut[i] = y;
      wet += y;
    }
    prevOut.set(curOut);
    wetOut[k] = wet;
  }
  return wetOut;
}

/** Peak magnitude of a buffer. */
function peakOf(buf: Float32Array): number {
  let p = 0;
  for (const v of buf) if (Math.abs(v) > p) p = Math.abs(v);
  return p;
}

/** dry + sympathetic wet, the wet scaled so its peak is `mix`x the dry peak. */
function addSympathetic(dry: Float32Array, s: Sympathetic): Float32Array {
  const wet = sympatheticWet(dry, s);
  const dp = peakOf(dry);
  const wp = peakOf(wet);
  const g = wp > 0 ? (s.mix * dp) / wp : 0; // fixed wet/dry loudness ratio
  const out = Float32Array.from(dry);
  for (let k = 0; k < out.length; k++) out[k] += g * wet[k];
  return out;
}

/** In-key resonator freqs: the song's pitch classes, placed across two octaves. */
function sympatheticFreqs(song: Song): number[] {
  const classes = new Set<number>();
  for (const n of song.notes) if (!(DROP_DRUMS && n.channel === 9)) classes.add(n.pitch % 12);
  const freqs: number[] = [];
  for (const pc of classes) for (const base of [48, 60]) freqs.push(midiToHz(base + pc));
  return freqs;
}

/** Feedback delay line (echo). Echoes recirculate at `feedback`, wet at `mix`. */
function applyDelay(buf: Float32Array, d: Delay): Float32Array {
  const D = Math.max(1, Math.floor(d.time * SR));
  const wet = new Float32Array(buf.length); // recirculating line: dry + fed-back echoes
  const out = Float32Array.from(buf);
  for (let k = 0; k < buf.length; k++) {
    const echo = k >= D ? wet[k - D] : 0;
    wet[k] = buf[k] + d.feedback * echo; // what will echo D samples later
    out[k] = buf[k] + d.mix * echo; // dry + wet tap
  }
  return out;
}

/**
 * Cheap Schroeder reverb: 4 parallel feedback combs (decorrelated delay lengths)
 * into 2 series allpasses. `room` scales comb feedback (tail length); `mix` is wet level.
 */
function applyReverb(buf: Float32Array, r: Reverb, seed = 0): Float32Array {
  const combLens = [1557, 1617, 1491, 1422].map((L) => L + seed); // seed shifts L/R for width
  const apLens = [225, 556];
  const fb = 0.7 + 0.28 * Math.min(Math.max(r.room, 0), 1); // 0.70..0.98
  const combs = combLens.map((L) => ({ buf: new Float32Array(L), i: 0 }));
  const aps = apLens.map((L) => ({ buf: new Float32Array(L), i: 0 }));

  const out = Float32Array.from(buf);
  for (let k = 0; k < out.length; k++) {
    const dry = buf[k];
    let wet = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.buf[c.i] = dry + y * fb;
      c.i = c.i + 1 === c.buf.length ? 0 : c.i + 1;
      wet += y;
    }
    wet *= 0.25;
    for (const a of aps) {
      const bufd = a.buf[a.i];
      const y = -wet + bufd;
      a.buf[a.i] = wet + bufd * 0.5;
      a.i = a.i + 1 === a.buf.length ? 0 : a.i + 1;
      wet = y;
    }
    out[k] = dry + r.mix * wet;
  }
  return out;
}

/** Encode a mono Float32 buffer as a 16-bit PCM WAV file. */
export function writeWav(buf: Float32Array, path: string): void {
  const dataBytes = buf.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16); // fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34); // bits per sample
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  for (let k = 0; k < buf.length; k++) {
    const s = Math.max(-1, Math.min(1, buf[k]));
    out.writeInt16LE((s * 32767) | 0, 44 + k * 2);
  }
  writeFileSync(path, out);
}

/** Encode two Float32 channels as an interleaved 16-bit stereo WAV. */
export function writeWavStereo(left: Float32Array, right: Float32Array, path: string): void {
  const frames = Math.min(left.length, right.length);
  const dataBytes = frames * 4; // 2 ch * 2 bytes
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(2, 22); // stereo
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 4, 28); // byte rate
  out.writeUInt16LE(4, 32); // block align
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  for (let k = 0; k < frames; k++) {
    const l = Math.max(-1, Math.min(1, left[k]));
    const r = Math.max(-1, Math.min(1, right[k]));
    out.writeInt16LE((l * 32767) | 0, 44 + k * 4);
    out.writeInt16LE((r * 32767) | 0, 44 + k * 4 + 2);
  }
  writeFileSync(path, out);
}

/** Read `--name value` from argv, or return the fallback. */
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/** Parse `"3:0.3,5:0.15"` into Harmonic[] (empty string -> no harmonics). */
function parseHarmonics(spec: string): Harmonic[] {
  if (!spec.trim()) return [];
  return spec.split(",").map((pair) => {
    const [mult, amp] = pair.split(":").map(Number);
    return { multiple: mult, amp: amp ?? 1 };
  });
}

// run directly:  node synth.ts [file.mid] [--play] [--attack ms] [--release ms]
//                               [--harmonics "3:0.3,5:0.15"] [--sine]
//                               [--fm] [--fm-ratio r] [--fm-index i] [--fm-decay s]
if (import.meta.filename === process.argv[1]) {
  // positional = first argv (after node+script) that is neither a --flag nor
  // the value consumed by a valued flag.
  const valued = new Set([
    "--attack",
    "--release",
    "--harmonics",
    "--voice",
    "--fm-ratio",
    "--fm-index",
    "--fm-decay",
    "--fm-sustain",
    "--wave",
    "--cutoff",
    "--res",
    "--env",
    "--env-decay",
    "--detune",
    "--unison",
    "--vowel",
    "--choir",
    "--vib-rate",
    "--vib-depth",
    "--delay-time",
    "--delay-fb",
    "--delay-mix",
    "--reverb-room",
    "--reverb-mix",
    "--ks-decay",
    "--ks-damping",
    "--symp-feedback",
    "--symp-damping",
    "--symp-mix",
    "--symp-couple",
  ]);
  const path = process.argv.slice(2).find((a, i) => {
    const prev = process.argv[2 + i - 1];
    return !a.startsWith("--") && !valued.has(prev);
  });

  const has = (f: string) => process.argv.includes(f);
  const voiceName = flag("voice", "");

  // Which engine? A named voice picks it; otherwise --ks/--sub/--fm/--formant or knobs.
  const subKnobs = ["--wave", "--cutoff", "--res", "--env", "--env-decay", "--detune", "--unison"];
  const fmKnobs = ["--fm-ratio", "--fm-index", "--fm-decay", "--fm-sustain"];
  const fmtKnobs = ["--vowel", "--choir"];
  const ksKnobs = ["--ks-decay", "--ks-damping"];
  const known = (v: string) =>
    FM_VOICES[v] || SUB_VOICES[v] || FORMANT_VOICES[v] || KS_VOICES[v];
  if (voiceName && !known(voiceName)) {
    const all = [
      ...Object.keys(FM_VOICES),
      ...Object.keys(SUB_VOICES),
      ...Object.keys(FORMANT_VOICES),
      ...Object.keys(KS_VOICES),
    ].join(", ");
    console.error(`unknown --voice "${voiceName}"; options: ${all}`);
    process.exit(1);
  }
  const ksOn = has("--ks") || voiceName in KS_VOICES || ksKnobs.some(has);
  const formantOn = !ksOn && (has("--formant") || voiceName in FORMANT_VOICES || fmtKnobs.some(has));
  const subOn = !ksOn && !formantOn && (has("--sub") || voiceName in SUB_VOICES || subKnobs.some(has));
  const fmOn =
    !ksOn && !formantOn && !subOn && (has("--fm") || voiceName in FM_VOICES || fmKnobs.some(has));

  const fp = FM_VOICES[voiceName] ?? DEFAULT_FM; // fm preset base
  const sp = SUB_VOICES[voiceName] ?? DEFAULT_SUB; // sub preset base
  const tp = FORMANT_VOICES[voiceName] ?? DEFAULT_FORMANT; // formant preset base
  const kp = KS_VOICES[voiceName] ?? DEFAULT_KS; // ks preset base

  const opts: RenderOptions = {
    attack: Number(flag("attack", "5")) / 1000, // ms -> s
    release: Number(flag("release", "30")) / 1000, // ms -> s
    harmonics: has("--sine") ? [] : parseHarmonics(flag("harmonics", "3:0.3,5:0.15")),
    fm: fmOn
      ? {
          ratio: Number(flag("fm-ratio", String(fp.ratio))),
          index: Number(flag("fm-index", String(fp.index))),
          decay: Number(flag("fm-decay", String(fp.decay))),
          sustain: Number(flag("fm-sustain", String(fp.sustain))),
        }
      : undefined,
    sub: subOn
      ? {
          wave: flag("wave", sp.wave) === "square" ? "square" : "saw",
          cutoff: Number(flag("cutoff", String(sp.cutoff))),
          resonance: Number(flag("res", String(sp.resonance))),
          envAmount: Number(flag("env", String(sp.envAmount))),
          envDecay: Number(flag("env-decay", String(sp.envDecay))),
          detune: Number(flag("detune", String(sp.detune))),
          voices: Number(flag("unison", String(sp.voices))),
        }
      : undefined,
    formant: formantOn
      ? {
          vowel: flag("vowel", tp.vowel),
          voices: Number(flag("choir", String(tp.voices))),
          detune: Number(flag("detune", String(tp.detune))),
        }
      : undefined,
    ks: ksOn
      ? {
          decay: Number(flag("ks-decay", String(kp.decay))),
          damping: Number(flag("ks-damping", String(kp.damping))),
        }
      : undefined,
    vibrato:
      has("--vibrato") || has("--vib-rate") || has("--vib-depth")
        ? { rate: Number(flag("vib-rate", "5.5")), depth: Number(flag("vib-depth", "25")) }
        : undefined,
    delay:
      has("--delay") || has("--delay-time") || has("--delay-fb") || has("--delay-mix")
        ? {
            time: Number(flag("delay-time", "0.3")),
            feedback: Number(flag("delay-fb", "0.35")),
            mix: Number(flag("delay-mix", "0.3")),
          }
        : undefined,
    reverb:
      has("--reverb") || has("--reverb-room") || has("--reverb-mix")
        ? { room: Number(flag("reverb-room", "0.7")), mix: Number(flag("reverb-mix", "0.3")) }
        : undefined,
    gm: has("--gm"),
    drums: has("--drums"),
    compress:
      has("--compress") || has("--comp-threshold") || has("--comp-ratio")
        ? {
            threshold: Number(flag("comp-threshold", "-18")),
            ratio: Number(flag("comp-ratio", "3")),
            attack: Number(flag("comp-attack", "0.005")),
            release: Number(flag("comp-release", "0.12")),
          }
        : undefined,
  };

  // no file given -> fall back to the bundled, hardcoded song data.
  const song = path ? parseMidi(path) : bundledSong;
  console.log(path ? `source: ${path}` : "source: bundled songData.ts (no file given)");
  const pitched = song.notes.filter((n) => !(DROP_DRUMS && n.channel === 9));

  // sympathetic resonance is tuned to the song, so build it now that we have it.
  const sympKnobs = ["--symp-feedback", "--symp-damping", "--symp-mix", "--symp-couple"];
  if (has("--sympathetic") || sympKnobs.some(has)) {
    opts.sympathetic = {
      freqs: sympatheticFreqs(song),
      feedback: Number(flag("symp-feedback", "0.9")),
      damping: Number(flag("symp-damping", "0.5")),
      mix: Number(flag("symp-mix", "0.35")),
      couple: Number(flag("symp-couple", "0.03")),
    };
  }
  if (opts.gm) {
    const byProg = new Map<number, number>();
    for (const p of song.programs) byProg.set(p.program, (byProg.get(p.program) ?? 0) + 1);
    const list = [...byProg.keys()].sort((a, b) => a - b).map((p) => `${p}:${GM_NAMES[p]}`);
    console.log(`GM: ${song.programs.length} program(s) -> ${list.join(", ") || "(none; defaulting to Acoustic Grand)"}`);
  }
  const tag = voiceName ? ` (${voiceName})` : "";
  const timbre = opts.gm
    ? "GM multi-instrument"
    : opts.ks
    ? `KS${tag} decay=${opts.ks.decay} damping=${opts.ks.damping}`
    : opts.formant
    ? `FORMANT${tag} vowel=${opts.formant.vowel} choir=${opts.formant.voices}@${opts.formant.detune}c`
    : opts.sub
    ? `SUB${tag} ${opts.sub.wave} cutoff=${opts.sub.cutoff}Hz res=${opts.sub.resonance} ` +
      `env=+${opts.sub.envAmount}Hz/${opts.sub.envDecay}s unison=${opts.sub.voices}@${opts.sub.detune}c`
    : opts.fm
      ? `FM${tag} ratio=${opts.fm.ratio} index=${opts.fm.index} ` +
        `decay=${opts.fm.decay}s sustain=${opts.fm.sustain}`
      : opts.harmonics.length
        ? `harmonics=${opts.harmonics.map((h) => `${h.multiple}:${h.amp}`).join(",")}`
        : "pure sine";
  console.log(
    `${song.notes.length} notes (${pitched.length} pitched after dropping drums), ` +
      `${song.duration.toFixed(1)}s @ ${song.tempoBpm} bpm`,
  );
  console.log(
    `voice: ${timbre}  attack=${(opts.attack * 1000).toFixed(1)}ms  ` +
      `release=${(opts.release * 1000).toFixed(1)}ms`,
  );
  const fx = [
    opts.vibrato && `vibrato ${opts.vibrato.rate}Hz/${opts.vibrato.depth}c`,
    opts.sympathetic &&
      `sympathetic ${opts.sympathetic.freqs.length} strings fb=${opts.sympathetic.feedback} ` +
        `couple=${opts.sympathetic.couple} mix=${opts.sympathetic.mix}`,
    opts.delay && `delay ${opts.delay.time}s fb=${opts.delay.feedback} mix=${opts.delay.mix}`,
    opts.reverb && `reverb room=${opts.reverb.room} mix=${opts.reverb.mix}`,
  ].filter(Boolean);
  if (fx.length) console.log(`fx: ${fx.join("  ")}`);

  const outFile = "chiptune.wav";
  const stereo = has("--stereo");
  if (stereo) {
    const [L, R] = renderStereo(song, opts);
    writeWavStereo(L, R, outFile);
    console.log(`wrote ${outFile}  (${(L.length / SR).toFixed(1)}s, stereo)`);
  } else {
    const buf = render(song, opts);
    writeWav(buf, outFile);
    console.log(`wrote ${outFile}  (${(buf.length / SR).toFixed(1)}s, mono)`);
  }

  if (process.argv.includes("--play")) {
    console.log("playing via aplay...");
    spawnSync("aplay", ["-q", outFile], { stdio: "inherit" });
  }
}
