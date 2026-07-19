/**
 * demoSong.ts — a SHORT, ORIGINAL demo used by the RELEASE build in place of the
 * local (copyrighted) songData.ts.
 *
 * Everything here is generated programmatically from a generic Am–F–C–G loop —
 * one of the most common chord cycles in popular music, and not itself something
 * anyone can own. No melody, rhythm, or note data is copied from any existing
 * song or recording; it is written from scratch to show off a handful of the
 * synth's voices (electric bass, piano, steel guitar arpeggio, string pad) and
 * the drum engine. Dedicated to the public domain (CC0) — reuse freely.
 *
 * Same shape as songData.ts: `export const song: Song`, so the web app treats it
 * identically. The release build swaps this in for songData.ts (see build.mjs
 * `--release`); the local dev build keeps using songData.ts.
 */
import type { Song, Note } from "../midiParse.ts";

// ---- musical material -------------------------------------------------------
// A minor: i – VI – III – VII (Am – F – C – G), the ubiquitous "four chords".
// bass = a low root; triad = a close mid-octave voicing (chosen for smooth
// voice-leading between chords).
const CHORDS: { bass: number; triad: [number, number, number] }[] = [
  { bass: 45, triad: [57, 60, 64] }, // Am : A2 | A3 C4 E4
  { bass: 41, triad: [53, 57, 60] }, // F  : F2 | F3 A3 C4
  { bass: 48, triad: [60, 64, 67] }, // C  : C3 | C4 E4 G4
  { bass: 43, triad: [55, 59, 62] }, // G  : G2 | G3 B3 D4
];
const PROGRESSION = [0, 1, 2, 3, 0, 1, 2, 3]; // 8 bars = two passes

const BPM = 120;
const BEAT = 60 / BPM; // 0.5 s
const BAR = 4 * BEAT; // 2.0 s

// GM channels / programs — deliberately varied to demonstrate several voices.
const CH = { bass: 0, piano: 1, guitar: 2, strings: 3, drums: 9 };
// GM percussion note numbers (all rendered by drums.ts).
const KICK = 36, SNARE = 38, HAT = 42, OPENHAT = 46, CRASH = 49;

function build(): Song {
  const notes: Note[] = [];
  const add = (barStart: number, beat: number, durBeats: number, pitch: number, velocity: number, channel: number, track: number) =>
    notes.push({ start: barStart + beat * BEAT, dur: durBeats * BEAT, pitch, velocity, channel, track });

  PROGRESSION.forEach((ci, bar) => {
    const chord = CHORDS[ci];
    const t0 = bar * BAR;
    const secondHalf = bar >= 4;
    const lastOfPhrase = bar === 3 || bar === 7;

    // Bass (electric bass): root / root / fifth / root — a simple walking pulse.
    add(t0, 0, 1.0, chord.bass, 96, CH.bass, 1);
    add(t0, 1.5, 0.5, chord.bass, 78, CH.bass, 1);
    add(t0, 2.0, 1.0, chord.bass + 7, 90, CH.bass, 1);
    add(t0, 3.0, 1.0, chord.bass, 88, CH.bass, 1);

    // Piano: block triad comped on beats 1 and 3.
    for (const p of chord.triad) {
      add(t0, 0, 1.8, p, 72, CH.piano, 2);
      add(t0, 2, 1.8, p, 68, CH.piano, 2);
    }

    // Steel-guitar arpeggio: 8 eighth-notes up-and-down over the triad + octave.
    const arp = [chord.triad[0] + 12, chord.triad[1] + 12, chord.triad[2] + 12, chord.triad[0] + 24];
    const pattern = [0, 1, 2, 3, 2, 1, 0, 1];
    pattern.forEach((idx, i) => add(t0, i * 0.5, 0.45, arp[idx], i === 0 ? 66 : 56, CH.guitar, 3));

    // String pad: enters on the second pass for a lift; sustained whole bar.
    if (secondHalf) {
      const pad = [chord.triad[1], chord.triad[2], chord.triad[0] + 12];
      for (const p of pad) add(t0, 0, 4.0, p, 52, CH.strings, 4);
    }

    // Drums (channel 9) --------------------------------------------------------
    // Hi-hats: straight eighths, accented on the beat; open hat lifts a phrase end.
    for (let i = 0; i < 8; i++) {
      const isLastEighth = i === 7;
      if (isLastEighth && lastOfPhrase) add(t0, 3.5, 0.4, OPENHAT, 70, CH.drums, 5);
      else add(t0, i * 0.5, 0.2, HAT, i % 2 === 0 ? 72 : 50, CH.drums, 5);
    }
    // Kick on 1 and 3, with a little syncopation in the odd bars.
    add(t0, 0, 0.4, KICK, 100, CH.drums, 5);
    add(t0, 2, 0.4, KICK, 92, CH.drums, 5);
    if (bar % 2 === 1 && !lastOfPhrase) add(t0, 2.75, 0.3, KICK, 78, CH.drums, 5);
    // Snare backbeat on 2 and 4.
    add(t0, 1, 0.4, SNARE, 96, CH.drums, 5);
    if (!lastOfPhrase) add(t0, 3, 0.4, SNARE, 96, CH.drums, 5);
    // Crash at the top of each 4-bar phrase.
    if (bar === 0 || bar === 4) add(t0, 0, 1.0, CRASH, 90, CH.drums, 5);
    // A modest snare fill closing each phrase (replaces beat-4 backbeat).
    if (lastOfPhrase) {
      add(t0, 3.0, 0.25, SNARE, 78, CH.drums, 5);
      add(t0, 3.25, 0.25, SNARE, 90, CH.drums, 5);
      add(t0, 3.5, 0.25, SNARE, 104, CH.drums, 5);
      add(t0, 3.75, 0.25, SNARE, 116, CH.drums, 5);
    }
  });

  notes.sort((a, b) => a.start - b.start);
  const duration = notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);

  return {
    ppq: 480,
    tempoBpm: BPM,
    duration,
    notes,
    lyrics: [],
    meta: [],
    programs: [
      { time: 0, track: 1, channel: CH.bass, program: 33 }, // Electric Bass (finger)
      { time: 0, track: 2, channel: CH.piano, program: 0 }, // Acoustic Grand Piano
      { time: 0, track: 3, channel: CH.guitar, program: 25 }, // Acoustic Guitar (steel)
      { time: 0, track: 4, channel: CH.strings, program: 48 }, // String Ensemble 1
      { time: 0, track: 5, channel: CH.drums, program: 0 }, // drums (channel 9)
    ],
  };
}

export const song: Song = build();
