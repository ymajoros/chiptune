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

export interface Song {
  ppq: number;
  tempoBpm: number;
  duration: number;
  notes: Note[];
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
  const data = readFileSync(path);

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
      } else if (event === 0xa0 || event === 0xb0 || event === 0xe0) {
        i += 2; // 2-byte channel messages
      } else if (event === 0xc0 || event === 0xd0) {
        i += 1; // 1-byte channel messages
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

  notes.sort((a, b) => a.start - b.start);
  const duration = notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
  const tempoBpm = Math.round((60_000_000 / tempoEvents[0][1]) * 10) / 10;

  return { ppq, tempoBpm, duration, notes };
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
