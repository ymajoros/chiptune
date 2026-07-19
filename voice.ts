/**
 * voice.ts — a Klatt-style formant voice synthesizer (speaks and sings).
 *
 * Source–filter model, the way a real voice works:
 *
 *   glottal pulse ──> nasal zero ──> formant cascade ──> lip radiation ──┐
 *                                      (F1..F5)                          ├──> out
 *   white noise ──> frication pole bank (parallel) ─────────────────────┘
 *
 *   - SOURCE: a Rosenberg glottal pulse at F0 (voiced), and/or noise. Real
 *     vocal folds make a pulse train, not a saw — the pulse shape (and its
 *     sharp closure) is what makes it sound human.
 *   - NASAL ZERO: an anti-resonator. Closing the lips/tongue leaves the oral
 *     cavity as a dead-end branch that traps energy, notching the spectrum.
 *   - FILTER: a cascade of 2-pole Klatt resonators at the formant frequencies.
 *     The vocal tract is a resonant tube; moving the formants = moving your
 *     tongue and lips. This is what turns a buzz into a vowel.
 *   - RADIATION: a differentiator, modelling sound leaving the lips (+6dB/oct).
 *     Only the voiced branch is radiated; frication is shaped by its own
 *     parallel pole bank and added after (see FRIC_GAIN / poles).
 *
 * Phonemes are interpolated between their targets (coarticulation), so the
 * tract glides continuously instead of jumping — that's what makes it read as
 * speech rather than beads on a string.
 *
 * Run:
 *   node voice.ts --say "bonjour tout le monde" --play
 *   node voice.ts --phonemes "b O~ Z u R" --play
 *   node voice.ts --sing "Z @ v w a l a m E R" --notes "71:0.5,69:0.5,67:0.3,67:0.9" --play
 */

import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SR = 44100;
/** Formant transition time (s) — how fast the tongue/lips actually move. */
const TRANS = 0.055;
/** Nasal cavity resonance (Hz) and its bandwidth — the murmur. */
const NASAL_POLE = 270;
const NASAL_BW = 250;

// ---------------------------------------------------------------- phonemes

type PhonType = "vowel" | "fricative" | "nasal" | "liquid" | "stop" | "silence";

interface Phon {
  type: PhonType;
  f: [number, number, number]; // F1,F2,F3 formant targets (Hz)
  bw?: [number, number, number]; // bandwidths (Hz)
  voiced: boolean; // glottal source on?
  /**
   * Voicing level 0..1 (default 1). Not every voiced sound is as loud as a
   * vowel: a constriction (voiced fricative) chokes glottal flow, and nasals
   * lose energy into the nasal cavity. Vowels are the loudest thing we say.
   */
  av?: number;
  noise?: number; // noise amplitude 0..1
  /**
   * Frication spectrum as a bank of band-pass poles [freq, bandwidth, gain].
   * Real frication is not one resonance: the constriction plus the cavity in
   * front of it produce several peaks. A single filter just sounds like
   * coloured hiss — the multi-pole shape is what reads as /s/ vs /S/ vs /f/.
   */
  poles?: [number, number, number][];
  /** Uvular trill depth 0..1 (the French R flutters ~28x/s). */
  trill?: number;
  /** Nasal anti-resonance frequency (Hz) — set by the oral side-branch length. */
  zeroF?: number;
  /** Nasality 0..1: how much of the anti-resonance is mixed in. */
  nas?: number;
  /**
   * Aspiration (/h/) is generated at the glottis, so it flows through the whole
   * vocal tract -> cascade. Frication (/s/, /S/...) is generated at a narrow
   * constriction near the front, so it must NOT go through the cascade: each
   * resonator has enormous gain at its peak and would blast the noise ~4x above
   * the vowels. Frication therefore takes a parallel branch with its own gain.
   */
  asp?: boolean;
  dur: number; // default duration (s)
}

/** Frication level, tuned so fricatives sit below the vowels (as in speech). */
const FRIC_GAIN = 0.06;

const BW: [number, number, number] = [80, 100, 140];
const NBW: [number, number, number] = [150, 180, 220]; // nasal/liquid: wider

/**
 * Formant targets. Vowels are the classic F1/F2 chart: F1 tracks mouth
 * openness (low=closed /i,u/, high=open /a/), F2 tracks tongue front/back
 * (high=front /i/, low=back /u/). Nasals (~) and French vowels included since
 * the reference song is French.
 */
const PHONEMES: Record<string, Phon> = {
  // --- oral vowels ---
  a: { type: "vowel", f: [800, 1200, 2500], voiced: true, dur: 0.12 },
  e: { type: "vowel", f: [400, 2000, 2600], voiced: true, dur: 0.11 }, // é
  E: { type: "vowel", f: [550, 1800, 2500], voiced: true, dur: 0.11 }, // è
  i: { type: "vowel", f: [300, 2300, 3000], voiced: true, dur: 0.1 },
  o: { type: "vowel", f: [400, 800, 2600], voiced: true, dur: 0.11 },
  O: { type: "vowel", f: [550, 900, 2600], voiced: true, dur: 0.11 }, // ɔ
  u: { type: "vowel", f: [320, 700, 2400], voiced: true, dur: 0.11 }, // ou
  y: { type: "vowel", f: [300, 1700, 2200], voiced: true, dur: 0.11 }, // u français
  "2": { type: "vowel", f: [400, 1500, 2300], voiced: true, dur: 0.11 }, // eu
  "@": { type: "vowel", f: [500, 1500, 2500], voiced: true, dur: 0.08 }, // schwa
  /**
   * Nasal vowels: the zero must sit BETWEEN the nasal pole (270Hz) and that
   * vowel's OWN F1 — it is a perturbation of the low end, not a hole in the
   * vowel. Placing it on F1 (A~ had its zero at 616 vs F1 700) notches out the
   * formant that defines the vowel: F1 fell 15dB and /ɑ̃/ collapsed into /ɔ̃/.
   * Nasal CONSONANTS are different — their F1 is only ~250, so their
   * place-dependent zero (750/1600/3000) correctly sits above it.
   */
  // --- nasal vowels (French) ---
  "A~": { type: "vowel", f: [700, 1100, 2500], bw: NBW, voiced: true, zeroF: 450, nas: 1, dur: 0.13 }, // an
  "O~": { type: "vowel", f: [450, 800, 2500], bw: NBW, voiced: true, zeroF: 340, nas: 1, dur: 0.13 }, // on
  "E~": { type: "vowel", f: [550, 1600, 2500], bw: NBW, voiced: true, zeroF: 400, nas: 1, dur: 0.13 }, // in
  "9~": { type: "vowel", f: [560, 1450, 2400], bw: NBW, voiced: true, zeroF: 350, nas: 1, dur: 0.13 }, // un (/œ̃/)
  // --- nasal consonants ---
  m: { type: "nasal", f: [250, 1000, 2200], bw: NBW, voiced: true, av: 0.7, zeroF: 750, nas: 1, dur: 0.07 },
  n: { type: "nasal", f: [250, 1700, 2600], bw: NBW, voiced: true, av: 0.7, zeroF: 1600, nas: 1, dur: 0.07 },
  N: { type: "nasal", f: [250, 2000, 2400], bw: NBW, voiced: true, av: 0.7, zeroF: 3000, nas: 1, dur: 0.07 }, // gn
  // --- liquids / glides ---
  l: { type: "liquid", f: [350, 1200, 2600], bw: NBW, voiced: true, av: 0.85, dur: 0.06 },
  /**
   * French R is UVULAR /ʁ/, not the English alveolar /ɹ/ (whose identity is a
   * dropped F3 ~1600). Two things matter: F3 stays HIGH, and — because the
   * constriction is at the very back — nearly the whole oral cavity is in FRONT
   * of the noise source, so its frication must be filtered BY the tract
   * (asp: true -> cascade), like /h/. Routing it through the parallel branch,
   * as /s/ needs, gives unshaped noise bands instead of a throat.
   */
  R: { type: "liquid", f: [400, 1150, 2400], bw: [130, 160, 200], voiced: true, av: 0.6, noise: 0.75, asp: true, trill: 0.35, dur: 0.09 },
  w: { type: "liquid", f: [300, 700, 2200], bw: NBW, voiced: true, av: 0.85, dur: 0.05 },
  j: { type: "liquid", f: [300, 2200, 3000], bw: NBW, voiced: true, av: 0.85, dur: 0.05 }, // y
  // --- fricatives (noise-driven) ---
  s: { type: "fricative", f: [320, 1750, 2600], voiced: false, noise: 1, poles: [[5800, 1250, 1], [7400, 2300, 0.6]], dur: 0.1 },
  z: { type: "fricative", f: [320, 1750, 2600], voiced: true, av: 0.5, noise: 0.6, poles: [[5800, 1250, 1], [7400, 2300, 0.6]], dur: 0.08 },
  S: { type: "fricative", f: [400, 1800, 2600], voiced: false, noise: 1, poles: [[2400, 550, 1], [3400, 1100, 0.7], [4800, 2100, 0.25]], dur: 0.1 }, // ch
  Z: { type: "fricative", f: [400, 1800, 2600], voiced: true, av: 0.5, noise: 0.6, poles: [[2400, 550, 1], [3400, 1100, 0.7], [4800, 2100, 0.25]], dur: 0.08 }, // j
  f: { type: "fricative", f: [350, 1100, 2300], voiced: false, noise: 0.08, poles: [[4200, 2000, 0.6], [7000, 2400, 0.5]], dur: 0.05 },
  v: { type: "fricative", f: [350, 1100, 2300], voiced: true, av: 0.5, noise: 0.05, poles: [[4200, 2000, 0.6], [7000, 2400, 0.5]], dur: 0.05 },
  h: { type: "fricative", f: [500, 1500, 2500], voiced: false, noise: 0.5, asp: true, dur: 0.06 },
  // --- stops: expanded into closure + burst at build time ---
  p: { type: "stop", f: [350, 800, 2200], voiced: false, poles: [[900, 1800, 1]], dur: 0.09 },
  b: { type: "stop", f: [350, 800, 2200], voiced: true, poles: [[900, 1800, 1]], dur: 0.08 },
  t: { type: "stop", f: [350, 1750, 2600], voiced: false, poles: [[4000, 1800, 1], [6200, 2300, 0.6]], dur: 0.09 },
  d: { type: "stop", f: [350, 1750, 2600], voiced: true, poles: [[4000, 1800, 1], [6200, 2300, 0.6]], dur: 0.08 },
  k: { type: "stop", f: [350, 1950, 2250], voiced: false, poles: [[2400, 700, 1]], dur: 0.09 },
  g: { type: "stop", f: [350, 1950, 2250], voiced: true, poles: [[2200, 700, 1]], dur: 0.08 },
  // --- silence ---
  _: { type: "silence", f: [500, 1500, 2500], voiced: false, dur: 0.12 },
};

const isVowel = (t: string) => PHONEMES[t]?.type === "vowel";

// ------------------------------------------------------------- DSP pieces

/** Klatt 2-pole resonator coefficients (unity DC gain). */
function reson(f: number, bw: number): [number, number, number] {
  const r = Math.exp((-Math.PI * bw) / SR);
  const theta = (2 * Math.PI * f) / SR;
  const b = 2 * r * Math.cos(theta);
  const c = -r * r;
  return [1 - b - c, b, c]; // [A,B,C] -> y = A*x + B*y1 + C*y2
}

/**
 * Klatt anti-resonator: literally the inverse of reson(), so it punches a ZERO
 * (a notch) into the spectrum instead of a peak. This is what a nasal really
 * is: closing the lips/tongue leaves the oral cavity as a dead-end side branch
 * that traps energy at its own resonance, cancelling it from the output. The
 * notch frequency encodes the place of articulation, which is how you hear
 * /m/ vs /n/. Wide bandwidths only fake the dullness, not the notch.
 * Returns an all-zero (FIR) filter: y = A*x + B*x1 + C*x2.
 */
function antireson(f: number, bw: number): [number, number, number] {
  const [A, B, C] = reson(f, bw);
  return [1 / A, -B / A, -C / A]; // unity DC gain, like reson
}

/**
 * RBJ band-pass (constant peak gain) — a TRUE band-pass, with zeros at DC and
 * Nyquist. Note reson() above is all-pole and normalised for unity gain at DC,
 * which is right for the vocal tract but wrong for noise: it would let low
 * frequencies straight through. Frication needs this.
 */
function bpf(f: number, bw: number): [number, number, number, number, number] {
  const w0 = (2 * Math.PI * f) / SR;
  const q = f / Math.max(bw, 1);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return [alpha / a0, 0, -alpha / a0, (-2 * Math.cos(w0)) / a0, (1 - alpha) / a0];
}

/**
 * Rosenberg glottal pulse: the vocal folds open smoothly, snap shut, then
 * stay closed. That asymmetric shape (and the sharp closure) is the source of
 * the voice's harmonic richness — far more natural than a saw or square.
 */
function glottal(t: number): number {
  const T1 = 0.4; // opening fraction
  const T2 = 0.16; // closing fraction
  if (t < T1) return 0.5 * (1 - Math.cos((Math.PI * t) / T1));
  if (t < T1 + T2) return Math.cos((Math.PI * (t - T1)) / (2 * T2));
  return 0;
}

// --------------------------------------------------------- the sequencer

interface Seg {
  f: [number, number, number]; // formant targets
  bw: [number, number, number];
  av: number; // voicing amplitude
  an: number; // noise amplitude
  poles: [number, number, number][]; // frication spectrum (band-pass bank)
  zf: number; // nasal anti-resonance frequency
  nas: number; // nasality 0..1
  tr: number; // uvular trill depth 0..1
  sil: boolean; // true silence — has no tongue position to glide toward
  asp: boolean; // noise through the cascade (aspiration) vs parallel (frication)
  dur: number;
}

/** Expand a phoneme token list into timed segments (stops -> closure+burst). */
/**
 * `scale` shrinks/stretches every formant: a man's vocal tract is ~17cm vs
 * ~15cm, so ALL his formants sit ~10% lower. Pitch alone does not make a voice
 * male — drop F0 without moving the formants and you get a child, or a chipmunk.
 */
function toSegments(tokens: string[], rate: number, durs?: number[], scale = 1): Seg[] {
  const segs: Seg[] = [];
  tokens.forEach((tok, i) => {
    const p = PHONEMES[tok];
    if (!p) throw new Error(`unknown phoneme "${tok}"`);
    const bw = p.bw ?? BW;
    const pf: [number, number, number] = [p.f[0] * scale, p.f[1] * scale, p.f[2] * scale];
    // velar pinch: /k g/ take their F2/F3 and burst from the FOLLOWING vowel's
    // F2 — high & converged before front vowels, low before back ones. Without
    // this, "qui" /ki/ reads as labial "pi".
    let velarBurst = 0;
    if ((tok === "k" || tok === "g") && i + 1 < tokens.length) {
      const nv = PHONEMES[tokens[i + 1]];
      if (nv && nv.type === "vowel") {
        const vf2 = nv.f[1];
        const pinch = Math.min(Math.max(vf2 + 250, 1300), 2900); // just above the vowel F2
        pf[1] = pinch * scale; // F2
        pf[2] = Math.max(pinch + 250, nv.f[2] * 0.9) * scale; // F3, kept close (pinch)
        velarBurst = pinch;
      }
    }
    const dur = (durs?.[i] ?? p.dur) / rate;
    if (p.type === "stop") {
      // closure: silence (voiced stops keep a faint low "voice bar"), then a burst
      const z = (p.zeroF ?? 1000) * scale;
      const nz = p.nas ?? 0;
      /**
       * A stop is: silence (closure) -> a very SHORT burst -> VOT aspiration.
       * The burst is only ~8ms; stretch it to ~27ms and it stops being a stop
       * and becomes an affricate ("tss"). It must also sit below vowel level.
       * The aspiration gap after release is what separates /t/ from /d/ — it
       * runs through the cascade, so the formants already gliding toward the
       * next vowel colour it, exactly as a real release does.
       */
      const bd = Math.min(0.012, dur * 0.15); // burst: ~12ms
      const ad = p.voiced ? Math.min(0.005, dur * 0.08) : Math.min(0.006, dur * 0.1); // VOT (French: short-lag)
      const cd = Math.max(0.02, dur - bd - ad); // closure
      segs.push({ f: pf, bw, av: p.voiced ? 0.06 : 0, an: 0, poles: p.poles ?? [], zf: z, nas: nz, tr: 0, sil: false, asp: false, dur: cd });
      const burstPoles = velarBurst ? [[velarBurst * scale, 700, 1] as [number, number, number]] : (p.poles ?? []);
      segs.push({ f: pf, bw, av: p.voiced ? 0.2 : 0, an: 0.32, poles: burstPoles, zf: z, nas: nz, tr: 0, sil: false, asp: false, dur: bd });
      segs.push({ f: pf, bw, av: p.voiced ? 0.5 : 0.35, an: p.voiced ? 0.12 : 0.12, poles: p.poles ?? [], zf: z, nas: nz, tr: 0, sil: false, asp: true, dur: ad });
    } else {
      segs.push({
        f: pf,
        bw,
        av: p.voiced ? (p.av ?? 1) : 0,
        an: p.noise ?? 0,
        poles: p.poles ?? [],
        zf: (p.zeroF ?? 1000) * scale,
        nas: p.nas ?? 0,
        tr: p.trill ?? 0,
        sil: p.type === "silence",
        asp: p.asp ?? false,
        dur,
      });
    }
  });
  return segs;
}

/**
 * Render segments with coarticulation: formants are interpolated between
 * segment *centres*, so the tract glides smoothly; amplitudes use short ramps
 * so stops and fricatives stay crisp. `f0At(t)` supplies the pitch contour.
 */
function renderSegments(segs: Seg[], f0At: (t: number) => number): Float32Array {
  const total = segs.reduce((s, g) => s + g.dur, 0);
  const n = Math.ceil(total * SR);
  const out = new Float32Array(n);

  // resonator state (5 formants: 3 phoneme-controlled + 2 fixed high ones)
  const y1 = [0, 0, 0, 0, 0];
  const y2 = [0, 0, 0, 0, 0];
  // frication band-pass state: SECT cascaded biquads per pole.
  // One 2-pole section rolls off only 6dB/oct, which leaves a broadband tail of
  // white noise under the peak — audible as a whisper behind the fricative.
  // Cascading doubles the skirt attenuation (~-21dB -> ~-42dB at 2kHz for /s/).
  const MAXP = 4;
  const SECT = 2;
  const nx1 = new Float64Array(MAXP * SECT);
  const nx2 = new Float64Array(MAXP * SECT);
  const ny1 = new Float64Array(MAXP * SECT);
  const ny2 = new Float64Array(MAXP * SECT);
  let azx1 = 0; // anti-resonator input history (it is an FIR)
  let azx2 = 0;
  let npy1 = 0; // nasal pole state
  let npy2 = 0;
  let phase = 0; // glottal phase
  let prevOut = 0; // lip-radiation differentiator state

  let si = 0; // current segment index
  let segStart = 0;

  for (let k = 0; k < n; k++) {
    const t = k / SR;
    while (si < segs.length - 1 && t >= segStart + segs[si].dur) {
      segStart += segs[si].dur;
      si++;
    }
    const seg = segs[si];

    /**
     * Coarticulation with a BOUNDED transition (~55ms), centred on each segment
     * boundary. Interpolating centre-to-centre instead makes the glide as long
     * as the segments: after a held vowel the tract would crawl to the next
     * target for ~250ms, passing through mid-central space and sounding like an
     * inserted schwa ("par-EU-sa"). Real articulators move in ~50ms whatever
     * the vowel's length. Half-widths are clamped to the shorter neighbour so
     * short segments (an 8ms burst) keep their own identity.
     */
    let f = seg.f;
    let bw = seg.bw;
    let zf = seg.zf;
    let nas = seg.nas;
    const segEndT = segStart + seg.dur;
    /**
     * Silence is NOT an articulatory target — the mouth is simply already
     * placed before you speak. Gliding to/from the "_" segment's nominal
     * formants dragged every short vowel through mid-central space and turned
     * it into a schwa ("a uh uh uh"): a 120ms vowel spends 55ms in transition,
     * so most of it was the glide.
     */
    const glideIn = si > 0 && !segs[si - 1].sil;
    const glideOut = si < segs.length - 1 && !segs[si + 1].sil;
    const hIn = glideIn ? Math.min(TRANS / 2, segs[si - 1].dur / 2, seg.dur / 2) : 0;
    const hOut = glideOut ? Math.min(TRANS / 2, seg.dur / 2, segs[si + 1].dur / 2) : 0;
    if (glideIn && t < segStart + hIn) {
      const p = segs[si - 1];
      const u = 0.5 + (t - segStart) / (2 * hIn); // 0.5 -> 1 after the boundary
      f = lerp3(p.f, seg.f, u);
      bw = lerp3(p.bw, seg.bw, u);
      zf = p.zf + (seg.zf - p.zf) * u;
      nas = p.nas + (seg.nas - p.nas) * u;
    } else if (glideOut && t > segEndT - hOut) {
      const nx = segs[si + 1];
      const u = (t - (segEndT - hOut)) / (2 * hOut); // 0 -> 0.5 up to the boundary
      f = lerp3(seg.f, nx.f, u);
      bw = lerp3(seg.bw, nx.bw, u);
      zf = seg.zf + (nx.zf - seg.zf) * u;
      nas = seg.nas + (nx.nas - seg.nas) * u;
    }

    // --- amplitudes: crossfade *between neighbours* across each boundary.
    // Ramping to zero at every edge would cut the voice out between two voiced
    // phonemes (a click); crossfading keeps av=1 -> av=1 perfectly continuous
    // while still fading quickly where the phonemes genuinely differ.
    const half = 0.008; // 16 ms crossfade centred on the boundary (softer stop/fric abutments)
    const segEnd = segStart + seg.dur;
    let av = seg.av;
    let an = seg.an;
    let tr = seg.tr;
    if (si > 0 && t < segStart + half) {
      const p = segs[si - 1];
      const u = (t - (segStart - half)) / (2 * half); // 0.5..1 across this half
      av = p.av + (seg.av - p.av) * u;
      an = p.an + (seg.an - p.an) * u;
      tr = p.tr + (seg.tr - p.tr) * u;
    } else if (si < segs.length - 1 && t > segEnd - half) {
      const nx = segs[si + 1];
      const u = (t - (segEnd - half)) / (2 * half); // 0..0.5 across this half
      av = seg.av + (nx.av - seg.av) * u;
      an = seg.an + (nx.an - seg.an) * u;
      tr = seg.tr + (nx.tr - seg.tr) * u;
    }
    // uvular trill: the uvula flutters against the tongue ~28x/s
    if (tr > 0) {
      const flutter = 1 - tr * (0.5 - 0.5 * Math.cos(2 * Math.PI * 28 * t));
      av *= flutter;
      an *= flutter;
    }
    // fade the very start/end of the utterance so it can't click on/off
    const fade = 0.006;
    const ends = Math.min(1, t / fade, (total - t) / fade);
    av *= Math.max(0, ends);
    an *= Math.max(0, ends);

    // --- SOURCE: glottal pulse + shaped noise ---
    const f0 = f0At(t);
    phase += f0 / SR;
    if (phase >= 1) phase -= 1;
    const gl = glottal(phase);
    const voice = gl * av;

    const white = Math.random() * 2 - 1;

    /**
     * Voiced fricatives pulse: airflow surges each time the folds open, so the
     * hiss is modulated by the glottal cycle. Steady noise + steady buzz reads
     * as two unrelated sounds; pulsed noise fuses into one voiced fricative.
     */
    const nmod = av > 0 && an > 0 ? 0.3 + 0.7 * gl : 1;

    // frication: sum of band-pass poles (the parallel branch)
    let fricRaw = 0;
    if (an > 0 && !seg.asp) {
      const np = Math.min(seg.poles.length, MAXP);
      for (let i = 0; i < np; i++) {
        const [pf, pbw, pg] = seg.poles[i];
        const [b0, b1, b2, a1, a2] = bpf(pf, pbw);
        let v = white;
        for (let j = 0; j < SECT; j++) {
          const q = i * SECT + j;
          const y = b0 * v + b1 * nx1[q] + b2 * nx2[q] - a1 * ny1[q] - a2 * ny2[q];
          nx2[q] = nx1[q];
          nx1[q] = v;
          ny2[q] = ny1[q];
          ny1[q] = y;
          v = y;
        }
        fricRaw += v * pg;
      }
    }

    // --- CASCADE branch: glottal voicing (+ aspiration) through the tract ---
    let s = voice + (seg.asp ? white * an * 0.25 : 0);

    /**
     * Nasal pole-zero pair, done Klatt's way. The nasal cavity adds a fixed
     * pole (~270Hz, the murmur) and a zero whose frequency is set by the oral
     * side-branch length (= place of articulation). Both sections are ALWAYS in
     * the cascade; for a non-nasal sound the zero is parked exactly on the pole
     * with the same bandwidth, so they cancel algebraically and the chain is
     * untouched. Nasality is then just "how far the zero moves off the pole" —
     * continuous, and it glides for free.
     *
     * (Blending each section against the dry signal separately, as I did
     * before, is not a pole-zero pair: the 270Hz resonator simply low-passes
     * everything and the vowel goes muddy and quiet.)
     */
    const zEff = NASAL_POLE + (zf - NASAL_POLE) * nas;
    const [pA, pB, pC] = reson(NASAL_POLE, NASAL_BW);
    const np = pA * s + pB * npy1 + pC * npy2;
    npy2 = npy1;
    npy1 = np;
    const [zA, zB, zC] = antireson(zEff, NASAL_BW);
    const nz = zA * np + zB * azx1 + zC * azx2;
    azx2 = azx1;
    azx1 = np;
    s = nz;

    // --- the vocal tract itself: cascade of formant resonators ---
    const freqs = [f[0], f[1], f[2], 3500, 4500];
    const bws = [bw[0], bw[1], bw[2], 200, 250];
    for (let i = 0; i < 5; i++) {
      const [A, B, C] = reson(freqs[i], bws[i]);
      const y = A * s + B * y1[i] + C * y2[i];
      y2[i] = y1[i];
      y1[i] = y;
      s = y;
    }

    // --- PARALLEL branch: frication, bypassing the cascade's huge peak gain.
    // FRIC_GAIN puts fricatives *below* the vowels, as in a real voice.
    const fric = fricRaw * an * nmod * FRIC_GAIN;

    // --- RADIATION: differentiate (sound leaving the lips) ---
    // Only the voiced/cascade branch is radiated: it models the glottal source's
    // steep spectral tilt being lifted +6dB/oct at the lips. Frication is added
    // *after*, so the pole bank above defines its spectrum directly instead of
    // being tilted upward into a hiss.
    const rad = s - prevOut;
    prevOut = s;
    out[k] = rad + fric;
  }

  // normalize
  let peak = 0;
  for (const v of out) if (Math.abs(v) > peak) peak = Math.abs(v);
  if (peak > 0) for (let k = 0; k < n; k++) out[k] = (out[k] / peak) * 0.9;
  return out;
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const u = Math.min(Math.max(t, 0), 1);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

// ------------------------------------------------------------- prosody

/**
 * Speech pitch: a declining contour (declination) with a little jitter.
 * Flat F0 is the #1 thing that makes synthetic speech sound robotic.
 */
function speechF0(base: number, total: number, question = false) {
  return (t: number) => {
    const p = t / total;
    let f = base * (1 - 0.25 * p); // declination: statements drift down
    // A French yes/no question ends on a rising terminal — without it, a
    // question reads as a flat statement no matter how it is punctuated.
    if (question) {
      const r = Math.max(0, (p - 0.68) / 0.32); // last third
      f *= 1 + 0.55 * r * r;
    }
    const jitter = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) + 0.002 * Math.sin(2 * Math.PI * 11 * t);
    return f * jitter;
  };
}

/**
 * Singing pitch. The larynx has mass — it cannot teleport between notes, it
 * SLIDES (portamento). Snapping cur.hz at each note boundary is precisely what
 * pitch-quantisation does, which is why it read as exaggerated autotune.
 *
 * The glide is done in the LOG domain (pitch is logarithmic, so a geometric
 * interpolation is the musically straight line), eased with a smoothstep, and
 * scaled by the interval: a big leap takes longer to travel than a step, as a
 * real voice does. Only the very first note gets a scoop — later notes arrive
 * from the previous pitch, so they need no invented one.
 */
function singF0(notes: { hz: number; start: number; dur: number }[]) {
  const GLIDE = 0.075; // portamento for a 1-semitone step (s)
  return (t: number) => {
    let i = 0;
    for (let k = 0; k < notes.length; k++) if (t >= notes[k].start) i = k;
    const cur = notes[i];
    const into = t - cur.start;

    let hz = cur.hz;
    if (i > 0) {
      const prev = notes[i - 1];
      const semis = Math.abs(12 * Math.log2(cur.hz / prev.hz));
      // bigger leaps glide a little longer, but never past the note itself
      const glide = Math.min(GLIDE * (0.6 + 0.4 * semis), cur.dur * 0.5, 0.16);
      if (semis > 0.01 && into < glide) {
        const u = into / glide;
        const e = u * u * (3 - 2 * u); // smoothstep: ease out of the old note, into the new
        hz = prev.hz * (cur.hz / prev.hz) ** e; // geometric = straight line in pitch
      }
    } else if (into < 0.06) {
      hz = cur.hz * 2 ** ((-0.5 * (1 - into / 0.06)) / 12); // scoop into the very first note
    }

    const vib = 1 + 0.012 * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, into / 0.25);
    return hz * vib;
  };
}

const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

// ------------------------------------------------------------- singing

/**
 * Split phonemes into syllables (one per vowel: onset consonants + vowel),
 * then fit one syllable per note: consonants keep their natural length and
 * the vowel stretches to fill the rest of the note. That's how a singer does
 * it — consonants are quick, vowels carry the melody.
 */
function syllabify(tokens: string[]): string[][] {
  const sylls: string[][] = [];
  let cur: string[] = [];
  /**
   * If the lyric uses "." the syllabification is EXPLICIT. Needed because the
   * default rule (every consonant is the onset of the following vowel) cannot
   * produce a coda: "p a R s a" would give /pa.ʁsa/ when "par sa" is
   * /paʁ.sa/, and "R o z l a" would give /ʁo.zla/ instead of /ʁoz.la/.
   */
  const explicit = tokens.includes(".");
  for (const tok of tokens) {
    // "-" is a melisma tie: hold the previous syllable across another note.
    // Real lyrics never line up one-syllable-per-note.
    if (tok === "-") {
      if (cur.length) {
        sylls.push(cur);
        cur = [];
      }
      sylls.push(["-"]);
      continue;
    }
    if (tok === ".") {
      if (cur.length) {
        sylls.push(cur);
        cur = [];
      }
      continue;
    }
    // "=" is a SPLIT: the next syllable shares the current note rather than
    // taking a new one. The inverse of "-". Needed because a simplified MIDI
    // lead holds one long note where the singer delivers several quick
    // syllables on that pitch — melisma cannot express that.
    if (tok === "=") {
      if (cur.length) {
        sylls.push(cur);
        cur = [];
      }
      sylls.push(["="]);
      continue;
    }
    cur.push(tok);
    if (!explicit && isVowel(tok)) {
      sylls.push(cur);
      cur = [];
    }
  }
  if (cur.length) {
    // In explicit mode the leftover is a finished syllable of its own. Only the
    // heuristic mode should glue a trailing consonant onto the previous
    // syllable as a coda — doing that in explicit mode merged the last written
    // syllable into its predecessor ("l a . m E R" -> "lamER").
    if (explicit || !sylls.length) sylls.push(cur);
    else sylls[sylls.length - 1].push(...cur);
  }
  return sylls;
}

/**
 * Sing syllables placed at ABSOLUTE times, each with its own pitch — the model a
 * karaoke (.kar) file gives you directly, since it stamps every sung syllable at
 * the tick it is sung on. Unlike singToBuffer this does not assume one syllable
 * per note or that syllables abut: real singing has rests, and the .kar timing
 * is the singer's own, so nothing has to be guessed.
 *
 * Gaps become silence; a syllable's consonants keep their natural length and its
 * vowel stretches to fill whatever time is left.
 */
export function singTimed(
  items: { phonemes: string[]; start: number; dur: number; midi: number }[],
  formantScale = 1,
): Float32Array {
  const segs: Seg[] = [];
  const noteTimes: { hz: number; start: number; dur: number }[] = [];
  let t = 0;
  for (const it of items) {
    if (it.start > t + 0.001) {
      segs.push(...toSegments(["_"], 1, [it.start - t], formantScale)); // rest
      t = it.start;
    }
    const consonants = it.phonemes.filter((x) => !isVowel(x));
    const conDur = consonants.reduce((s, x) => s + PHONEMES[x].dur, 0);
    const squeeze = conDur > it.dur * 0.7 ? (it.dur * 0.7) / conDur : 1;
    const vowelDur = Math.max(0.03, it.dur - conDur * squeeze);
    const durs = it.phonemes.map((x) => (isVowel(x) ? vowelDur : PHONEMES[x].dur * squeeze));
    segs.push(...toSegments(it.phonemes, 1, durs, formantScale));
    noteTimes.push({ hz: midiToHz(it.midi), start: t, dur: conDur * squeeze + vowelDur });
    t += conDur * squeeze + vowelDur;
  }
  return renderSegments(segs, singF0(noteTimes));
}

/** Sing `tokens` over `notes` and return the audio buffer (used by chorus.ts). */
export function singToBuffer(
  tokens: string[],
  notes: { midi: number; dur: number }[],
  formantScale = 1,
): Float32Array {
  const { segs, noteTimes } = buildSinging(tokens, notes, formantScale);
  return renderSegments(segs, singF0(noteTimes));
}

function buildSinging(tokens: string[], notes: { midi: number; dur: number }[], scale = 1) {
  const sylls = syllabify(tokens);

  /**
   * A unit is one note-slot. `noteCount > 1` is a melisma (one syllable held
   * across several notes); `syls.length > 1` is a split (several syllables
   * sharing the slot, dividing its time at a constant pitch).
   */
  const units: { syls: string[][]; noteCount: number }[] = [];
  let shareNext = false;
  for (const syl of sylls) {
    if (syl.length === 1 && syl[0] === "-") {
      if (!units.length) throw new Error('melisma "-" with no preceding syllable');
      units[units.length - 1].noteCount++;
      continue;
    }
    if (syl.length === 1 && syl[0] === "=") {
      if (!units.length) throw new Error('split "=" with no preceding syllable');
      shareNext = true;
      continue;
    }
    if (shareNext) {
      units[units.length - 1].syls.push(syl);
      shareNext = false;
    } else {
      units.push({ syls: [syl], noteCount: 1 });
    }
  }

  const needed = units.reduce((s, u) => s + u.noteCount, 0);
  if (needed !== notes.length) {
    const shown = units.map((u) => u.syls.map((x) => x.join("")).join("=")).join(" ");
    console.error(
      `note/syllable mismatch: ${needed} notes needed by ${units.length} slots ` +
        `(${shown}) but ${notes.length} notes given. ` +
        `"-" holds a syllable over an extra note; "=" shares a note between syllables.`,
    );
    process.exit(1);
  }

  const segs: Seg[] = [];
  const noteTimes: { hz: number; start: number; dur: number }[] = [];
  let t = 0;
  let ni = 0;
  for (const u of units) {
    const mine = notes.slice(ni, ni + u.noteCount);
    ni += u.noteCount;
    const span = mine.reduce((s, n) => s + n.dur, 0);
    const share = span / u.syls.length; // split the slot evenly between its syllables

    for (const syl of u.syls) {
      const consonants = syl.filter((x) => !isVowel(x));
      const conDur = consonants.reduce((s, x) => s + PHONEMES[x].dur, 0);
      // a split syllable may be shorter than its own consonants: squeeze them
      const squeeze = conDur > share * 0.7 ? (share * 0.7) / conDur : 1;
      const vowelDur = Math.max(0.03, share - conDur * squeeze);
      const durs = syl.map((x) => (isVowel(x) ? vowelDur : PHONEMES[x].dur * squeeze));
      segs.push(...toSegments(syl, 1, durs, scale));
      t += conDur * squeeze + vowelDur;
    }

    // one F0 entry per note, so a tied syllable changes pitch mid-vowel and a
    // split keeps every syllable on the same pitch
    let nt = t - span;
    for (const n of mine) {
      noteTimes.push({ hz: midiToHz(n.midi), start: nt, dur: n.dur });
      nt += n.dur;
    }
  }
  return { segs, noteTimes };
}

// ------------------------------------------------- crude French grapheme->phoneme

/**
 * A small, deliberately-crude French letter-to-sound ruleset — enough for
 * demo words. Real G2P needs a dictionary; use --phonemes for exact control.
 */
function frenchG2P(word: string): string[] {
  const s = word.toLowerCase();
  const out: string[] = [];
  let i = 0;
  const rules: [string, string[]][] = [
    ["eau", ["o"]], ["au", ["o"]], ["ou", ["u"]], ["oi", ["w", "a"]],
    ["ain", ["E~"]], ["ein", ["E~"]], ["in", ["E~"]], ["im", ["E~"]],
    ["an", ["A~"]], ["am", ["A~"]], ["en", ["A~"]], ["em", ["A~"]],
    ["on", ["O~"]], ["om", ["O~"]], ["un", ["E~"]],
    ["ai", ["E"]], ["ei", ["E"]], ["eu", ["2"]], ["oeu", ["2"]],
    ["ch", ["S"]], ["gn", ["N"]], ["qu", ["k"]], ["ph", ["f"]], ["th", ["t"]],
    ["ss", ["s"]], ["ll", ["l"]], ["mm", ["m"]], ["nn", ["n"]], ["tt", ["t"]], ["pp", ["p"]],
    ["é", ["e"]], ["è", ["E"]], ["ê", ["E"]], ["à", ["a"]], ["ç", ["s"]], ["û", ["y"]], ["ô", ["o"]],
    ["er", ["e"]], ["ez", ["e"]],
  ];
  outer: while (i < s.length) {
    for (const [pat, ph] of rules) {
      if (s.startsWith(pat, i)) {
        out.push(...ph);
        i += pat.length;
        continue outer;
      }
    }
    const c = s[i];
    const next = s[i + 1] ?? "";
    const single: Record<string, string[]> = {
      a: ["a"], e: ["@"], i: ["i"], o: ["O"], u: ["y"], y: ["i"],
      b: ["b"], d: ["d"], f: ["f"], j: ["Z"], k: ["k"], l: ["l"], m: ["m"],
      n: ["n"], p: ["p"], r: ["R"], t: ["t"], v: ["v"], w: ["w"], x: ["k", "s"], z: ["z"],
    };
    if (c === "c") out.push("eiy".includes(next) ? "s" : "k");
    else if (c === "g") out.push("eiy".includes(next) ? "Z" : "g");
    else if (c === "s") out.push(/[aeiouy]/.test(s[i - 1] ?? "") && /[aeiouy]/.test(next) ? "z" : "s");
    else if (c === "h") {
      /* silent in French */
    } else if (single[c]) out.push(...single[c]);
    i++;
  }
  // drop a common silent final consonant
  const last = out[out.length - 1];
  if (out.length > 2 && ["t", "d", "s", "z", "p", "k"].includes(last)) out.pop();
  return out;
}

// ------------------------------------------------------------------ wav

function writeWav(buf: Float32Array, path: string): void {
  const bytes = buf.length * 2;
  const out = Buffer.alloc(44 + bytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + bytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(bytes, 40);
  for (let k = 0; k < buf.length; k++) {
    const s = Math.max(-1, Math.min(1, buf[k]));
    out.writeInt16LE((s * 32767) | 0, 44 + k * 2);
  }
  writeFileSync(path, out);
}

// ------------------------------------------------------------------ CLI

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

if (import.meta.filename === process.argv[1]) {
  const has = (f: string) => process.argv.includes(f);
  const f0 = Number(flag("f0", "110")); // base pitch (Hz); ~110 male, ~200 female
  const rate = Number(flag("rate", "1")); // speech rate multiplier
  const outFile = flag("out", "voice.wav");
  const fscale = Number(flag("formants", "1")); // <1 = longer tract = more male

  let audio: Float32Array;
  let pitchInfo: string;

  if (has("--sing")) {
    const tokens = flag("sing", "").trim().split(/\s+/).filter(Boolean);
    const transpose = Number(flag("transpose", "0")); // semitones (-12 = an octave down)
    const notes = flag("notes", "")
      .split(",")
      .filter(Boolean)
      .map((s) => {
        const [m, d] = s.split(":").map(Number);
        return { midi: m + transpose, dur: d ?? 0.5 };
      });
    if (!tokens.length || !notes.length) {
      console.error('usage: --sing "k i a" --notes "71:0.5,69:0.5,67:0.4"');
      process.exit(1);
    }
    const { segs, noteTimes } = buildSinging(tokens, notes, fscale);
    console.log(
      `singing ${syllabify(tokens).map((s) => s.join("")).join("-")} ` +
        `over ${notes.length} notes`,
    );
    audio = renderSegments(segs, singF0(noteTimes));
    pitchInfo = `pitch from notes (${notes.map((n) => n.midi).join(",")})`; // --f0 unused when singing
  } else {
    // speech: either explicit phonemes or crude G2P over text
    let tokens: string[];
    if (has("--phonemes")) {
      tokens = flag("phonemes", "").trim().split(/\s+/).filter(Boolean);
    } else {
      const text = flag("say", "bonjour");
      tokens = [];
      text.split(/\s+/).forEach((w, i) => {
        if (i) tokens.push("_"); // pause between words
        tokens.push(...frenchG2P(w));
      });
      console.log(`"${text}" -> /${tokens.join(" ")}/`);
    }
    if (!tokens.length) {
      console.error("nothing to say");
      process.exit(1);
    }
    const segs = toSegments(tokens, rate, undefined, fscale);
    const total = segs.reduce((s, g) => s + g.dur, 0);
    const question = has("--question") || flag("say", "").trim().endsWith("?");
    audio = renderSegments(segs, speechF0(f0, total, question));
    pitchInfo = `f0=${f0}Hz ${question ? "rising (question)" : "declining"}`;
  }

  writeWav(audio, outFile);
  console.log(`wrote ${outFile} (${(audio.length / SR).toFixed(2)}s, ${pitchInfo})`);
  if (has("--play")) spawnSync("aplay", ["-q", outFile], { stdio: "inherit" });
}
