/**
 * karSing.ts — sing a karaoke (.kar) MIDI file directly.
 *
 * A .kar carries the lyrics as Text meta events, one per SUNG syllable, stamped
 * at the tick it's sung on. That's the singer's own alignment, already done — so
 * nothing has to be guessed:
 *
 *   syllable TEXT   <- .kar lyric event      -> phonemes (French G2P)
 *   syllable TIME   <- .kar lyric event tick -> when to sing it
 *   syllable PITCH  <- the melody note sounding at that time
 *
 * This supersedes hand-aligning lyrics to note ranges (see lyrics.ts): the melody
 * track here has 307 notes but the vocal has 329 syllables, and only ~53% of
 * syllables land on a note start — so the melody is a simplified instrumental
 * lead, not a syllable-accurate vocal line. Timing must come from the .kar.
 *
 * Run:  node karSing.ts <file.kar|file.mid> [--from 27] [--to 60]
 *                       [--transpose -12] [--formants 0.88] [--voice organ]
 *                       [--dry] [--play]
 */

import { parseMidi, type Song } from "./midiParse.ts";
import { render, writeWav, DEFAULT_OPTS, FM_VOICES, SUB_VOICES, type RenderOptions } from "./synth.ts";
import { singToBuffer, singTimed } from "./voice.ts";
import { LYRICS } from "./songLyrics.ts";

const SR = 44100;

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (f: string) => process.argv.includes(f);

const path = process.argv.slice(2).find((a, i) => {
  const prev = process.argv[2 + i - 1];
  return !a.startsWith("--") && !["--from", "--to", "--transpose", "--formants", "--voice", "--out"].includes(prev);
});
if (!path) {
  console.error("usage: node karSing.ts <file.kar> [--from s] [--to s] [--play]");
  process.exit(1);
}

let transpose = Number(flag("transpose", "-24"));
// transpose only in whole octaves, or the voice clashes with the backing harmony
if (transpose % 12 !== 0) {
  const snapped = Math.round(transpose / 12) * 12;
  console.warn(`--transpose ${transpose} is not an octave; snapping to ${snapped} to stay in key`);
  transpose = snapped;
}
const formants = Number(flag("formants", "0.86")); // octave-lower singer; pitch stays octave-aligned
const voiceName = flag("voice", "organ");
const outFile = flag("out", "karsing.wav");

const song = parseMidi(path);
if (!song.lyrics.length) {
  console.error(`${path} has no lyric events — not a .kar file.`);
  process.exit(1);
}
console.log(song.meta.filter((m) => m.startsWith("@T") || m.startsWith("@L")).join("  |  "));

const from = Number(flag("from", String(LYRICS[0][0] / 1000 - 0.5)));
const to = Number(flag("to", String(LYRICS[LYRICS.length - 1][0] / 1000 + 3)));

// ---- timing model, chosen by density ---------------------------------------
// The melody track is a simplified INSTRUMENTAL lead, not the vocal line. When
// it has ~one note per syllable (the refrain) we follow it for pitch+rhythm.
// But the verse has 81 syllables over 65 lead notes — following it would cram
// two syllables onto a note and shove others >1s from where they're sung. There
// the .kar's own onsets ARE the vocal rhythm, so we use those and take pitch
// from whatever melody note is sounding at each syllable.
const allMel = parseMidi(path).notes
  .filter((n) => n.track === 3 && n.channel === 0)
  .sort((a, b) => a.start - b.start);
const rows = LYRICS.filter((r) => r[0] / 1000 >= from - 0.15 && r[0] / 1000 <= to).filter((r) => r[2].trim());

const forced = flag("time", ""); // "kar" | "lead" | "" (auto per section)
const SR2 = 44100;

/** Pitch = the melody note sounding at time t (a held note spans many syllables), else nearest. */
function pitchAt(t: number): number {
  const sounding = allMel.find((n) => t >= n.start - 0.03 && t < n.start + n.dur);
  if (sounding) return sounding.pitch;
  let best = allMel[0];
  let bd = Infinity;
  for (const n of allMel) {
    const d = Math.abs(n.start - t);
    if (d < bd) { bd = d; best = n; }
  }
  return best.pitch;
}

/** Render one section [a,b) with the chosen timing model; buffer starts at t=0. */
function renderSection(secRows: typeof rows, a: number, b: number): { buf: Float32Array; mode: string } {
  const secMel = allMel.filter((n) => n.start >= a - 0.05 && n.start < b);
  let aligned = 0;
  for (const r of secRows) {
    const t = r[0] / 1000;
    if (secMel.some((n) => Math.abs(n.start - t) < 0.07)) aligned++;
  }
  const onsetFrac = secRows.length ? aligned / secRows.length : 0;
  const useKar = forced ? forced === "kar" : onsetFrac < 0.7;
  if (useKar || secMel.length === 0) {
    // .kar onsets = the real sung rhythm; duration = gap to the next syllable.
    const items = secRows.map((r, i) => {
      const t = r[0] / 1000;
      const next = secRows[i + 1];
      let dur = next ? next[0] / 1000 - t : 0.6;
      if (next && next[4]) dur = Math.min(dur, 0.9);
      return { phonemes: r[2].trim().split(/\s+/), start: t - a, dur: Math.min(Math.max(dur, 0.08), 2.5), midi: pitchAt(t) + transpose };
    });
    return { buf: singTimed(items, formants), mode: "kar" };
  }
  // lead-following: melody notes drive pitch+rhythm; kar assigns syllable->note.
  const perNote: string[][] = secMel.map(() => []);
  let ni = 0;
  for (const r of secRows) {
    const t = r[0] / 1000;
    while (ni < secMel.length - 1 && Math.abs(secMel[ni + 1].start - t) <= Math.abs(secMel[ni].start - t)) ni++;
    perNote[ni].push(r[2].trim());
  }
  const toks: string[] = [];
  const noteList: { midi: number; dur: number }[] = [];
  let started = false;
  secMel.forEach((n, i) => {
    const dur = i < secMel.length - 1 ? secMel[i + 1].start - n.start : n.dur;
    noteList.push({ midi: n.pitch + transpose, dur });
    const sy = perNote[i];
    if (sy.length === 0) { if (started) toks.push("-"); else toks.push("_", "."); }
    else { started = true; sy.forEach((syl, k) => { toks.push(...syl.split(/\s+/)); if (k < sy.length - 1) toks.push("="); }); toks.push("."); }
  });
  return { buf: singToBuffer(toks, noteList, formants), mode: "lead" };
}

// Split the window into sections at paragraph breaks — a verse and a refrain
// want DIFFERENT timing models, so choosing one mode over the whole song fails.
// Each paragraph picks its own by its own syllable/note density.
const bounds: number[] = [from];
for (const r of rows) if (r[4] === "para" && r[0] / 1000 > from + 0.5) bounds.push(r[0] / 1000);
bounds.push(to);

const lead = new Float32Array(Math.ceil((to - from) * SR2) + SR2);
const modes: string[] = [];
for (let si = 0; si < bounds.length - 1; si++) {
  const a = bounds[si];
  const b = bounds[si + 1];
  const secRows = rows.filter((r) => r[0] / 1000 >= a - 0.05 && r[0] / 1000 < b);
  if (!secRows.length) continue;
  const { buf, mode } = renderSection(secRows, a, b);
  modes.push(mode);
  const off = Math.floor((a - from) * SR2);
  for (let k = 0; k < buf.length && off + k < lead.length; k++) lead[off + k] += buf[k];
}
console.log(`${rows.length} syllables in ${bounds.length - 1} sections -> [${modes.join(", ")}]`);
console.log(`transpose ${transpose}, formants x${formants}`);

// ---- backing: everything but the melody line, cropped to the window ----
let out = lead;
if (!has("--dry")) {
  const backingNotes = song.notes
    .filter((n) => !(n.track === 3 && n.channel === 0))
    .filter((n) => n.start < to && n.start + n.dur > from)
    .map((n) => ({ ...n, start: Math.max(0, n.start - from), dur: Math.min(n.dur, to - n.start) }));
  const backing: Song = { ppq: song.ppq, tempoBpm: song.tempoBpm, duration: to - from, notes: backingNotes, lyrics: [], meta: [], programs: [] };
  const opts: RenderOptions = { ...DEFAULT_OPTS, fm: FM_VOICES[voiceName], sub: SUB_VOICES[voiceName] };
  const music = render(backing, opts);
  const n = Math.max(music.length, lead.length);
  out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = 0.5 * (music[k] ?? 0) + 0.95 * (lead[k] ?? 0);
  let peak = 0;
  for (const v of out) if (Math.abs(v) > peak) peak = Math.abs(v);
  if (peak > 0) for (let k = 0; k < n; k++) out[k] = (out[k] / peak) * 0.9;
  console.log(`backing: ${backingNotes.length} notes, voice: ${voiceName}`);
}

writeWav(out, outFile);
console.log(`wrote ${outFile} (${(out.length / SR).toFixed(2)}s)`);
if (has("--play")) {
  const { spawnSync } = await import("node:child_process");
  spawnSync("aplay", ["-q", outFile], { stdio: "inherit" });
}
