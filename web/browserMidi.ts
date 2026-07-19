// Browser MIDI reader: wrap an ArrayBuffer in a Buffer-like view and feed it to
// the engine's platform-independent parseMidiData. The view is a Uint8Array
// subclass (so numeric indexing and .length are native) with the three Buffer
// methods midiParse relies on.
import { parseMidiData, type Song } from "../midiParse.ts";

class BufferView extends Uint8Array {
  readUInt16BE(o: number): number {
    return (this[o] << 8) | this[o + 1];
  }
  readUInt32BE(o: number): number {
    return (this[o] * 0x1000000) + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]);
  }
  toString(enc?: string, start = 0, end = this.length): string {
    // midiParse uses "ascii" (chunk tags) and "latin1" (lyrics). Both map bytes
    // 1:1 to code points here, which is exactly what the parser expects.
    let s = "";
    for (let i = start; i < end; i++) s += String.fromCharCode(this[i]);
    return s;
  }
}

export function parseMidiBuffer(ab: ArrayBuffer): Song {
  const view = new BufferView(ab.slice(0));
  // parseMidiData is typed against Node's Buffer; the view satisfies the subset used.
  return parseMidiData(view as unknown as Buffer);
}
