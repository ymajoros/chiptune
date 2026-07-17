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
import { singTimed } from "./voice.ts";
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

const transpose = Number(flag("transpose", "-12"));
const formants = Number(flag("formants", "0.88"));
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

// ---- syllables -> singable items, from the pre-generated (editable) table ----
const rows = LYRICS.filter((r) => r[0] / 1000 >= from && r[0] / 1000 <= to);
const items: { phonemes: string[]; start: number; dur: number; midi: number }[] = [];
rows.forEach((r, i) => {
  const [ms, , phon, midi, brk] = r;
  const next = rows[i + 1];
  let dur = next ? next[0] / 1000 - ms / 1000 : 0.6;
  if (next && next[4]) dur = Math.min(dur, 0.9); // clip before a line/para break
  dur = Math.min(Math.max(dur, 0.08), 2.5);
  if (!phon.trim()) return; // rows left empty in songLyrics.ts are skipped
  items.push({ phonemes: phon.trim().split(/\s+/), start: ms / 1000 - from, dur, midi: midi + transpose });
});

console.log(`${rows.length} syllables in ${from.toFixed(1)}s..${to.toFixed(1)}s`);
console.log(`transpose ${transpose}, formants x${formants}`);

const lead = singTimed(items, formants);

// ---- backing: everything but the melody line, cropped to the window ----
let out = lead;
if (!has("--dry")) {
  const backingNotes = song.notes
    .filter((n) => !(n.track === 3 && n.channel === 0))
    .filter((n) => n.start < to && n.start + n.dur > from)
    .map((n) => ({ ...n, start: Math.max(0, n.start - from), dur: Math.min(n.dur, to - n.start) }));
  const backing: Song = { ppq: song.ppq, tempoBpm: song.tempoBpm, duration: to - from, notes: backingNotes, lyrics: [], meta: [] };
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
