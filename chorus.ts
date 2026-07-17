/**
 * chorus.ts — the whole thing together: sing the refrain of "Je vois la mer"
 * over the song's own backing track.
 *
 *   songData.ts ──> melody notes (track 3 / ch 0) ──> voice.ts  (sung lead)
 *               └─> everything else               ──> synth.ts  (backing)
 *                                                        └─────> mix ──> chorus.wav
 *
 * The melody track is removed from the backing, because the voice sings it.
 *
 * Run:  node chorus.ts [--section chorus|verse|all] [--transpose -12]
 *                      [--voice organ] [--formants 0.88] [--play]
 */

import { song } from "./songData.ts";
import { render, writeWav, DEFAULT_OPTS, FM_VOICES, SUB_VOICES, type Song, type RenderOptions } from "./synth.ts";
import { singToBuffer } from "./voice.ts";
import { SECTIONS } from "./lyrics.ts";

const SR = 44100;

const MEL_TRACK = 3;
const MEL_CHAN = 0;

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const transpose = Number(flag("transpose", "-12")); // an octave down by default
const voiceName = flag("voice", "organ");
const formants = Number(flag("formants", "0.88")); // <1 = longer vocal tract = male
const sectionName = flag("section", "chorus");
const section = SECTIONS[sectionName];
if (!section) {
  console.error(`unknown --section "${sectionName}"; options: ${Object.keys(SECTIONS).join(", ")}`);
  process.exit(1);
}
const FIRST = section.first;
const LAST = section.last;
const outFile = flag("out", `${section.name}.wav`);

// ---- melody + window ----
const mel = song.notes
  .filter((n) => n.track === MEL_TRACK && n.channel === MEL_CHAN)
  .sort((a, b) => a.start - b.start);
const t0 = mel[FIRST].start;
const t1 = mel[LAST - 1].start + mel[LAST - 1].dur;

/**
 * Syllable durations come from consecutive note STARTS, not each note's own
 * length: the singer holds each syllable until the next one begins. Summing
 * raw note durations would drift against the backing wherever the MIDI has
 * small gaps.
 */
const notes: { midi: number; dur: number }[] = [];
for (let i = FIRST; i < LAST; i++) {
  const dur = i < LAST - 1 ? mel[i + 1].start - mel[i].start : mel[i].dur;
  notes.push({ midi: mel[i].pitch + transpose, dur });
}

// ---- backing: every other track, cropped to the window and shifted to 0 ----
const backingNotes = song.notes
  .filter((n) => !(n.track === MEL_TRACK && n.channel === MEL_CHAN))
  .filter((n) => n.start < t1 && n.start + n.dur > t0)
  .map((n) => ({ ...n, start: Math.max(0, n.start - t0), dur: Math.min(n.dur, t1 - n.start) }));

const backing: Song = {
  ppq: song.ppq,
  tempoBpm: song.tempoBpm,
  duration: t1 - t0,
  notes: backingNotes,
  lyrics: [],
  meta: [],
  programs: [],
};

const opts: RenderOptions = {
  ...DEFAULT_OPTS,
  fm: FM_VOICES[voiceName],
  sub: SUB_VOICES[voiceName],
};

console.log(`[${section.name}] ${t0.toFixed(2)}s..${t1.toFixed(2)}s (${(t1 - t0).toFixed(2)}s)`);
console.log(`text: ${section.text}`);
console.log(`backing: ${backingNotes.length} notes, voice: ${voiceName}`);
console.log(`lead: ${notes.length} notes, transpose ${transpose}, formants x${formants} (male)`);

const music = render(backing, opts);
const lead = singToBuffer(section.lyrics.trim().split(/\s+/), notes, formants);

// ---- mix ----
const n = Math.max(music.length, lead.length);
const out = new Float32Array(n);
for (let k = 0; k < n; k++) out[k] = 0.5 * (music[k] ?? 0) + 0.95 * (lead[k] ?? 0);
let peak = 0;
for (const v of out) if (Math.abs(v) > peak) peak = Math.abs(v);
if (peak > 0) for (let k = 0; k < n; k++) out[k] = (out[k] / peak) * 0.9;

writeWav(out, outFile);
console.log(`wrote ${outFile} (${(n / SR).toFixed(2)}s)`);
if (process.argv.includes("--play")) {
  const { spawnSync } = await import("node:child_process");
  spawnSync("aplay", ["-q", outFile], { stdio: "inherit" });
}
