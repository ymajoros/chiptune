/**
 * gm.ts — map the 128 General MIDI instruments onto our synth engines.
 *
 * The palette is small (additive / FM / subtractive / Karplus-Strong / formant),
 * so these are impressions, not samples: a plucked KS string for guitars, a
 * decaying FM tone for pianos and bells, a filtered unison saw for strings and
 * pads, a steady FM voice for organs and reeds, near-sine for flutes. Grouped by
 * the 16 GM families (each 8 programs), with a few per-instrument overrides.
 */

import type { FmConfig, SubConfig, KsConfig, FormantConfig, Harmonic, SympatheticVoice, AmpConfig } from "./synth.ts";

/** The timbre half of RenderOptions — one instrument's voice. */
export interface Voice {
  attack: number;
  release: number;
  gain: number; // per-instrument level (basses loud, flutes soft)
  foldAbove?: number; // fold notes above this MIDI pitch down an octave
  harmonics?: Harmonic[];
  fm?: FmConfig;
  sub?: SubConfig;
  ks?: KsConfig;
  formant?: FormantConfig;
  sympathetic?: SympatheticVoice;
  amp?: AmpConfig;
}

const fm = (ratio: number, index: number, decay: number, sustain: number): FmConfig => ({ ratio, index, decay, sustain });
const sub = (wave: "saw" | "square", cutoff: number, resonance: number, envAmount: number, envDecay: number, detune: number, voices: number, drive = 1): SubConfig => ({ wave, cutoff, resonance, envAmount, envDecay, detune, voices, drive });
const ks = (decay: number, damping: number, body = 0, stiffness = 0, pick = 0, tone = 1, extra?: Partial<KsConfig>): KsConfig => ({ decay, damping, body, stiffness, pick, tone, ...extra });
const symp = (strings: number[], feedback: number, damping: number, mix: number): SympatheticVoice => ({ strings, feedback, damping, mix });
const cab = (drive: number, presence: number, cabLow: number, level: number): AmpConfig => ({ drive, presence, cabLow, level });
const GTR_STRINGS = [40, 45, 50, 55, 59, 64]; // guitar open strings E2 A2 D3 G3 B3 E4

// --- family defaults (program >> 3 selects the family) ---
const FAMILY: Voice[] = [
  // 0  Piano — struck, bright decaying FM (Rhodes-ish)
  { attack: 0.004, release: 0.08, gain: 0.9, fm: fm(1, 6, 0.5, 0) },
  // 1  Chromatic percussion — inharmonic FM bell, long ring
  { attack: 0.003, release: 0.15, gain: 0.8, fm: fm(3.5, 6, 1.2, 0) },
  // 2  Organ — additive DRAWBARS (Hammond is sines at 8'/5⅓'/4'/2⅔'/2'…), which
  //     is richer and cuts through a mix far better than a thin FM sine did.
  { attack: 0.015, release: 0.05, gain: 0.95, foldAbove: 81, harmonics: [{ multiple: 2, amp: 0.6 }, { multiple: 3, amp: 0.35 }, { multiple: 4, amp: 0.45 }, { multiple: 6, amp: 0.2 }] },
  // 3  Guitar — plucked Karplus-Strong string. (damping 1.0 -> the averager's
  //     bEff 0.5, i.e. the old code's darkest point at b=0.5, preserved after the
  //     damping-monotonicity fix that halved the knob's mapping.)
  { attack: 0.003, release: 0.08, gain: 0.95, ks: ks(0.996, 1.0) },
  // 4  Bass — low filtered saw, quick filter env
  { attack: 0.005, release: 0.06, gain: 1.1, sub: sub("saw", 500, 0.3, 900, 0.12, 0, 1) },
  // 5  Strings — bowed: unison saw through a slow filter
  { attack: 0.06, release: 0.15, gain: 0.7, sub: sub("saw", 1500, 0.12, 1000, 0.6, 12, 4) },
  // 6  Ensemble — thicker unison strings / pad
  { attack: 0.08, release: 0.2, gain: 0.6, sub: sub("saw", 1300, 0.1, 900, 0.8, 16, 5) },
  // 7  Brass — FM with a bright attack that stays present
  { attack: 0.02, release: 0.08, gain: 0.85, fm: fm(1, 5, 0.3, 0.6) },
  // 8  Reed — steady, hollow (mostly odd harmonics)
  { attack: 0.03, release: 0.08, gain: 0.75, fm: fm(1, 3, 0.2, 0.75) },
  // 9  Pipe — near sine (flute), a touch of 2nd harmonic
  { attack: 0.04, release: 0.08, gain: 0.7, harmonics: [{ multiple: 2, amp: 0.08 }] },
  // 10 Synth lead — bright saw lead
  { attack: 0.005, release: 0.06, gain: 0.85, sub: sub("saw", 2200, 0.35, 1500, 0.3, 6, 2) },
  // 11 Synth pad — slow, wide, dark
  { attack: 0.2, release: 0.3, gain: 0.6, sub: sub("saw", 900, 0.15, 700, 1.2, 18, 5) },
  // 12 Synth effects — evolving FM
  { attack: 0.1, release: 0.2, gain: 0.6, fm: fm(2.5, 5, 1.5, 0.4) },
  // 13 Ethnic — plucked (sitar/banjo/koto), brighter string. (damping doubled
  //     0.35->0.70 to preserve timbre after the damping-mapping fix.)
  { attack: 0.003, release: 0.08, gain: 0.9, ks: ks(0.994, 0.7) },
  // 14 Percussive — short FM bell / mallet
  { attack: 0.002, release: 0.1, gain: 0.8, fm: fm(3, 5, 0.35, 0) },
  // 15 Sound effects — best-effort noisy sub
  { attack: 0.05, release: 0.1, gain: 0.5, sub: sub("saw", 1200, 0.5, 2000, 0.4, 20, 3) },
];

/** Per-program overrides where the family default misses badly. */
const OVERRIDE: Record<number, Voice> = {
  0: { attack: 0.002, release: 0.2, gain: 0.82, ks: ks(0.9968, 0.84, 0.3, 0.42, 0, 0.5, { strings: 3, spread: 3.5, velBright: 0.45, pluckNoise: 0.05 }) }, // Acoustic Grand — 3 slightly-detuned strings (unison beating/chorus), harder = brighter, felt-hammer tick (damping 0.42->0.84 preserves tone after the mapping fix)
  16: { attack: 0.012, release: 0.05, gain: 1.0, foldAbove: 81, harmonics: [{ multiple: 2, amp: 0.7 }, { multiple: 3, amp: 0.4 }, { multiple: 4, amp: 0.5 }, { multiple: 6, amp: 0.25 }, { multiple: 8, amp: 0.15 }] }, // Drawbar Organ — full registration
  // Percussive Organ — this arrangement doubles it high (C6-E6); the 6'/8' drawbars
  // there scream past 8kHz and bury the mix, so keep it low and drop the top ranks.
  17: { attack: 0.006, release: 0.05, gain: 0.6, foldAbove: 81, harmonics: [{ multiple: 2, amp: 0.5 }, { multiple: 3, amp: 0.28 }, { multiple: 4, amp: 0.2 }] },
  29: { attack: 0.005, release: 0.16, gain: 0.9, ks: ks(0.998, 0.34, 0.06, 0.06, 0.13, 0.62), amp: cab(3, 0.6, 4300, 1.0) }, // Overdrive Guitar — KS string driven through the amp
  19: { attack: 0.05, release: 0.12, gain: 0.85, foldAbove: 81, harmonics: [{ multiple: 2, amp: 0.5 }, { multiple: 3, amp: 0.3 }, { multiple: 4, amp: 0.5 }, { multiple: 5, amp: 0.25 }, { multiple: 8, amp: 0.2 }] }, // Church Organ — fuller, principal ranks
  30: { attack: 0.004, release: 0.2, gain: 0.9, ks: ks(0.999, 0.3, 0.05, 0.05, 0.1, 0.72), amp: cab(6, 0.75, 3800, 0.85) }, // Distortion Guitar — KS string, high amp drive
  // Finger Bass — matched to the record's measured bass: rounded (h2~0.5, fast
  // harmonic rolloff) and plucked (decays to ~0.2 sustain over ~0.3s).
  33: { attack: 0.006, release: 0.05, gain: 1.5, fm: fm(1, 2.8, 0.25, 0.28) },
  // Fretless Bass — a bass IS a plucked string, so use Karplus-Strong: it decays
  // naturally (no drone, unlike the sustaining sub family default). Voiced soft and
  // round for the fretless "mwah": soft finger pluck (tone 0.4, pick 0.3 mid-string),
  // moderate damping rolling off the highs into a singing tone, a long low ring
  // (decay 0.9975), a touch of body, a slightly slower/softer attack than a picked bass.
  35: { attack: 0.018, release: 0.1, gain: 1.4, ks: ks(0.99, 1.0, 0, 0, 0.45, 0.5, { loopCut: 1200 }) }, // Fretless Bass — Extended-KS loop loss (freq-dependent damping): bright pluck settles to a round low tone, decays like a real string (no sitar)
  38: { attack: 0.004, release: 0.05, gain: 1.15, sub: sub("saw", 700, 0.5, 1400, 0.12, 0, 1) }, // Synth Bass 1
  45: { attack: 0.003, release: 0.08, gain: 0.85, ks: ks(0.99, 0.8, 0.12, 0.16, 0.25, 0.55) }, // Pizzicato Strings — plucked, bodied (damping 0.4->0.8 preserves tone after the mapping fix)
  46: { attack: 0.003, release: 0.2, gain: 0.85, ks: ks(0.998, 0.7, 0.2, 0.1, 0.22, 0.62), sympathetic: symp([36, 41, 43, 45, 48, 50, 52, 55, 57, 60, 64, 67], 0.72, 0.25, 0.22) }, // Orchestral Harp — resonant string (damping 0.35->0.70 preserved)
  52: { attack: 0.08, release: 0.2, gain: 0.7, formant: { vowel: "a", voices: 4, detune: 12 } }, // Choir Aahs
  53: { attack: 0.08, release: 0.2, gain: 0.7, formant: { vowel: "o", voices: 4, detune: 14 } }, // Voice Oohs
  71: { attack: 0.03, release: 0.08, gain: 0.75, harmonics: [{ multiple: 3, amp: 0.4 }, { multiple: 5, amp: 0.2 }, { multiple: 7, amp: 0.1 }] }, // Clarinet — odd harmonics
  73: { attack: 0.05, release: 0.08, gain: 0.65, harmonics: [{ multiple: 2, amp: 0.05 }] }, // Flute — nearly pure
  // Rain (FX 1) — an airy, detuned shimmer WASH, not the metallic inharmonic FM the
  // synth-effects family default gave (which read as weird and near-inaudible). High
  // cutoff + wide-detuned saws for a light-rain/wind-chime shimmer; a moderate attack
  // so the short high notes still speak (the Venus arrangement plays it as a prominent
  // B4-F#5 melodic line, 0.1-0.46s notes), and a long-ish release for an ambient tail.
  96: { attack: 0.03, release: 0.55, gain: 1.35, sub: sub("saw", 4500, 0.18, 1600, 0.45, 21, 6) }, // Rain — airy detuned shimmer wash
  // Atmosphere (FX 4) — a soft, dark, slowly-evolving PAD, not the metallic FM
  // that read as a sitar. Wide detuned saws through a low cutoff, slow attack.
  99: { attack: 0.08, release: 0.6, gain: 1.7, sub: sub("saw", 700, 0.12, 500, 2.0, 22, 5) },
  // Guitar family on the resonant-string model, deliberately differentiated and
  // re-voiced for the fixed (now monotonic) damping. Measured HF-energy ratio
  // spreads them clearly: nylon 0.45 (warmest/woodiest) < clean 0.67 < steel 0.70
  // (brightest/ringiest); jazz is the dark mellow archtop, muted the short palm-mute.
  24: { attack: 0.022, release: 0.16, gain: 0.95, ks: ks(0.994, 0.92, 0.62, 0.03, 0.44, 0.2), sympathetic: symp(GTR_STRINGS, 0.5, 0.42, 0.14) }, // Nylon Guitar — soft warm nylon: slow finger pluck, warm+bodied, mid-string
  25: { attack: 0.016, release: 0.18, gain: 0.9, ks: ks(0.9975, 0.3, 0.24, 0.12, 0.42, 0.62), sympathetic: symp(GTR_STRINGS, 0.55, 0.32, 0.2) }, // Steel Guitar — bright but less cutting: mid-string pluck, warmer
  26: { attack: 0.012, release: 0.16, gain: 0.9, ks: ks(0.9965, 0.62, 0.3, 0.05, 0.3, 0.42), amp: cab(1.15, 0.25, 3600, 1.05) }, // Jazz Guitar — mellow hollow-body archtop through a warm, dark cab (was falling through to the generic guitar, identical to Muted)
  27: { attack: 0.022, release: 0.16, gain: 0.9, ks: ks(0.996, 0.5, 0.1, 0.02, 0.26, 0.5, { strings: 2, spread: 4, pluckNoise: 0.14 }), sympathetic: symp(GTR_STRINGS, 0.55, 0.35, 0.18), amp: cab(1.4, 0.7, 4500, 1.15) }, // Clean Guitar — electric; 2 strings +4c beating + pick-contact noise for a live vibrating-string feel (not synthy)
  28: { attack: 0.004, release: 0.06, gain: 0.9, ks: ks(0.972, 0.9, 0.08, 0.02, 0.2, 0.34, { releaseDamp: 0.4 }) }, // Muted Guitar — palm-muted: very short/choked decay, dark (was falling through to the generic guitar, identical to Jazz)
  80: { attack: 0.005, release: 0.06, gain: 0.8, sub: sub("square", 2200, 0.3, 1400, 0.3, 4, 2) }, // Square Lead
};

/** The voice for a GM program number (0..127). */
export function gmVoice(program: number): Voice {
  return OVERRIDE[program] ?? FAMILY[program >> 3];
}

/** GM instrument names, for logging. */
export const GM_NAMES = [
  "Acoustic Grand", "Bright Piano", "Electric Grand", "Honky-tonk", "E.Piano 1", "E.Piano 2", "Harpsichord", "Clavi",
  "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
  "Drawbar Organ", "Perc Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
  "Nylon Guitar", "Steel Guitar", "Jazz Guitar", "Clean Guitar", "Muted Guitar", "Overdrive Gtr", "Distortion Gtr", "Gtr Harmonics",
  "Acoustic Bass", "Finger Bass", "Pick Bass", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
  "Violin", "Viola", "Cello", "Contrabass", "Tremolo Str", "Pizzicato Str", "Orchestral Harp", "Timpani",
  "String Ens 1", "String Ens 2", "Synth Str 1", "Synth Str 2", "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
  "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass Section", "Synth Brass 1", "Synth Brass 2",
  "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet",
  "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
  "Square Lead", "Saw Lead", "Calliope", "Chiff Lead", "Charang", "Voice Lead", "Fifths Lead", "Bass+Lead",
  "New Age Pad", "Warm Pad", "Polysynth Pad", "Choir Pad", "Bowed Pad", "Metallic Pad", "Halo Pad", "Sweep Pad",
  "Rain", "Soundtrack", "Crystal", "Atmosphere", "Brightness", "Goblins", "Echoes", "Sci-Fi",
  "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
  "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
  "Gtr Fret Noise", "Breath Noise", "Seashore", "Bird Tweet", "Telephone", "Helicopter", "Applause", "Gunshot",
];
