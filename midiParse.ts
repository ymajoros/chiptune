/**
 * Minimal Standard-MIDI-File (SMF) parser -> easily readable note structure.
 *
 * No external dependencies. Produces a plain object:
 *
 *   { ppq, tempoBpm, duration, notes: Note[] }
 *
 * Each Note is flat { start, dur, pitch, velocity, channel, track } (seconds),
 * sorted by start time, so a trivial additive synth can just iterate `notes`.
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface Note {
  start: number; // seconds
  dur: number; // seconds
  pitch: number; // MIDI note 0..127
  velocity: number; // 1..127
  channel: number;
  track: number;
}

/**
 * One karaoke syllable. `.kar` files (a MIDI convention, not a separate format)
 * carry the lyrics as Text/Lyric meta events, one per SUNG syllable, stamped at
 * the tick it is sung on — i.e. the singer's own alignment, already done.
 * `\` starts a paragraph and `/` starts a line; both are stripped into `break`.
 */
export interface Lyric {
  time: number; // seconds
  text: string; // the syllable, as written
  break: "" | "line" | "para";
}

/** A General MIDI program (instrument) selection, stamped at the tick it takes effect. */
export interface Program {
  time: number; // seconds
  track: number;
  channel: number;
  program: number; // GM program number 0..127
}

export interface Song {
  ppq: number;
  tempoBpm: number;
  duration: number;
  notes: Note[];
  lyrics: Lyric[]; // empty unless the file is a .kar
  meta: string[]; // @-tags: title, artist, language...
  programs: Program[]; // GM program-change events (empty if none)
  reverb?: Record<string, number>; // per "track:channel" CC91 reverb depth, 0..1 (only channels that set it)
}

/** Read a MIDI variable-length quantity; returns [value, nextIndex]. */
function readVlq(data: Buffer, i: number): [number, number] {
  let value = 0;
  for (;;) {
    const b = data[i++];
    value = (value << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [value, i];
}

export function parseMidi(path: string): Song {
  return parseMidiData(readFileSync(path));
}

/**
 * Platform-independent MIDI parser: takes an already-loaded buffer (Node
 * `Buffer` from the CLI, or a small Buffer-like `Uint8Array` view in the
 * browser — see web/browserMidi.ts) so the same parser runs in both places.
 */
export function parseMidiData(data: Buffer): Song {
  // ---- header chunk ----
  if (data.toString("ascii", 0, 4) !== "MThd") throw new Error("not a MIDI file");
  const division = data.readUInt16BE(12);
  if (division & 0x8000) throw new Error("SMPTE time division not supported");
  const ppq = division;
  const ntracks = data.readUInt16BE(10);
  let pos = 14;

  const tempoEvents: [number, number][] = []; // [absTick, usPerQuarter]
  const rawNotes: [number, number, number, number, number, number][] = [];
  // [startTick, endTick, pitch, velocity, channel, track]
  const rawLyrics: [number, string][] = []; // [absTick, syllable]
  const meta: string[] = []; // @-tags from a .kar header
  const rawPrograms: [number, number, number, number][] = []; // [absTick, track, channel, program]
  const rawReverb = new Map<string, number>(); // "track:channel" -> last CC91 (reverb depth) value 0..127

  for (let track = 0; track < ntracks; track++) {
    if (data.toString("ascii", pos, pos + 4) !== "MTrk") throw new Error("bad track header");
    const length = data.readUInt32BE(pos + 4);
    pos += 8;
    const end = pos + length;
    let i = pos;
    let absTick = 0;
    let runningStatus = 0;
    // active notes: "channel:pitch" -> [startTick, velocity]
    const active = new Map<number, [number, number]>();

    while (i < end) {
      let delta: number;
      [delta, i] = readVlq(data, i);
      absTick += delta;

      let status = data[i];
      if (status & 0x80) {
        i++;
        runningStatus = status;
      } else {
        status = runningStatus; // running status: reuse previous
      }

      const event = status & 0xf0;
      const channel = status & 0x0f;

      if (status === 0xff) {
        // meta event
        const metaType = data[i++];
        let mlen: number;
        [mlen, i] = readVlq(data, i);
        if (metaType === 0x51 && mlen === 3) {
          const uspq = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          tempoEvents.push([absTick, uspq]);
        } else if (metaType === 0x01 || metaType === 0x05) {
          // Text (0x01) / Lyric (0x05). latin1: .kar files predate UTF-8.
          const txt = data.toString("latin1", i, i + mlen);
          if (txt.startsWith("@")) meta.push(txt); // @KMIDI, @T title, @L lang...
          else if (txt.trim() !== "") rawLyrics.push([absTick, txt]);
        }
        i += mlen;
      } else if (status === 0xf0 || status === 0xf7) {
        // sysex
        let slen: number;
        [slen, i] = readVlq(data, i);
        i += slen;
      } else if (event === 0x80 || event === 0x90) {
        // note off / note on
        const pitch = data[i];
        const vel = data[i + 1];
        i += 2;
        const key = (channel << 8) | pitch;
        if (event === 0x90 && vel > 0) {
          active.set(key, [absTick, vel]);
        } else {
          const found = active.get(key);
          if (found) {
            active.delete(key);
            rawNotes.push([found[0], absTick, pitch, found[1], channel, track]);
          }
        }
      } else if (event === 0xb0) {
        const cc = data[i], val = data[i + 1];
        i += 2;
        if (cc === 91) rawReverb.set(`${track}:${channel}`, val); // CC91 = reverb send depth
      } else if (event === 0xa0 || event === 0xe0) {
        i += 2; // 2-byte channel messages (poly aftertouch / pitch bend)
      } else if (event === 0xc0) {
        rawPrograms.push([absTick, track, channel, data[i]]); // program change
        i += 1;
      } else if (event === 0xd0) {
        i += 1; // channel aftertouch
      } else {
        i += 1; // unknown; best-effort skip
      }
    }

    pos = end;
  }

  if (tempoEvents.length === 0) tempoEvents.push([0, 500000]); // default 120 bpm
  tempoEvents.sort((a, b) => a[0] - b[0]);

  // ---- convert ticks -> seconds through the tempo map ----
  const tickToSec = (tick: number): number => {
    let sec = 0;
    let prevTick = 0;
    let prevUspq = tempoEvents[0][1];
    for (const [t, uspq] of tempoEvents) {
      if (t >= tick) break;
      sec += ((t - prevTick) * (prevUspq / 1_000_000)) / ppq;
      prevTick = t;
      prevUspq = uspq;
    }
    sec += ((tick - prevTick) * (prevUspq / 1_000_000)) / ppq;
    return sec;
  };

  const notes: Note[] = rawNotes.map(([startTick, endTick, pitch, velocity, channel, track]) => {
    const start = tickToSec(startTick);
    const dur = Math.max(tickToSec(endTick) - start, 0.01);
    return { start, dur, pitch, velocity, channel, track };
  });

  const lyrics: Lyric[] = rawLyrics
    .sort((a, b) => a[0] - b[0])
    .map(([tick, raw]) => {
      const brk = raw.startsWith("\\") ? "para" : raw.startsWith("/") ? "line" : "";
      return { time: tickToSec(tick), text: raw.replace(/^[\\/]/, ""), break: brk as "" | "line" | "para" };
    });

  const programs: Program[] = rawPrograms
    .sort((a, b) => a[0] - b[0])
    .map(([tick, track, channel, program]) => ({ time: tickToSec(tick), track, channel, program }));

  notes.sort((a, b) => a.start - b.start);
  const duration = notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
  const tempoBpm = Math.round((60_000_000 / tempoEvents[0][1]) * 10) / 10;

  const reverb: Record<string, number> = {};
  for (const [k, v] of rawReverb) reverb[k] = v / 127;

  return { ppq, tempoBpm, duration, notes, lyrics, meta, programs, reverb };
}

// run directly:  node midiParse.ts <file.mid>
if (import.meta.filename === process.argv[1]) {
  const path = process.argv[2] ?? `${process.env.HOME}/Downloads/Patrick_singer_Qui_A_Le_Droit.mid`;
  const song = parseMidi(path);
  console.log(
    `ppq=${song.ppq}  tempo=${song.tempoBpm} bpm  ` +
      `duration=${song.duration.toFixed(1)}s  notes=${song.notes.length}`,
  );
  writeFileSync("song.json", JSON.stringify(song, null, 1));
  console.log("wrote song.json");
}
