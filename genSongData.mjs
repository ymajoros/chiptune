import { parseMidi } from "./midiParse.ts";
import { writeFileSync } from "node:fs";

const path = process.argv[2];
const song = parseMidi(path);
const title = process.argv[3] ?? "song";

const REC = 12; // float32 start, float32 dur, uint8 x4
const bin = Buffer.alloc(song.notes.length * REC);
song.notes.forEach((n, i) => {
  const o = i * REC;
  bin.writeFloatLE(n.start, o);
  bin.writeFloatLE(n.dur, o + 4);
  bin.writeUInt8(n.pitch, o + 8);
  bin.writeUInt8(n.velocity, o + 9);
  bin.writeUInt8(n.channel, o + 10);
  bin.writeUInt8(n.track, o + 11);
});
const b64 = bin.toString("base64").replace(/(.{100})/g, "$1\n");

const lines = [];
lines.push("/**");
lines.push(" * songData.ts — GENERATED (see genSongData.mjs). A song pre-parsed and embedded");
lines.push(" * so synth.ts runs with no .mid on disk. Notes are packed little-endian, 12 bytes:");
lines.push(" *   float32 start, float32 dur, uint8 pitch, uint8 velocity, uint8 channel, uint8 track.");
lines.push(" * (float32 times: audibly exact; a note may shift <=1 sample vs the .mid.)");
lines.push(" *");
lines.push(` * ${title}. ${song.notes.length} notes, ${song.duration.toFixed(1)}s @ ${song.tempoBpm} bpm.`);
lines.push(" */");
lines.push("");
lines.push('import type { Song, Note } from "./midiParse.ts";');
lines.push("");
lines.push("const REC = 12;");
lines.push("const DATA_B64 =");
lines.push("  `" + b64 + "`;");
lines.push("");
lines.push("function decode(): Note[] {");
lines.push('  const bin = Buffer.from(DATA_B64, "base64");');
lines.push("  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);");
lines.push("  const notes: Note[] = [];");
lines.push("  for (let o = 0; o < bin.length; o += REC) {");
lines.push("    notes.push({");
lines.push("      start: dv.getFloat32(o, true),");
lines.push("      dur: dv.getFloat32(o + 4, true),");
lines.push("      pitch: dv.getUint8(o + 8),");
lines.push("      velocity: dv.getUint8(o + 9),");
lines.push("      channel: dv.getUint8(o + 10),");
lines.push("      track: dv.getUint8(o + 11),");
lines.push("    });");
lines.push("  }");
lines.push("  return notes;");
lines.push("}");
lines.push("");
const progs = song.programs
  .map((p) => `{ time: ${+p.time.toFixed(4)}, track: ${p.track}, channel: ${p.channel}, program: ${p.program} }`)
  .join(",\n    ");
lines.push("export const song: Song = {");
lines.push(`  ppq: ${song.ppq},`);
lines.push(`  tempoBpm: ${song.tempoBpm},`);
lines.push(`  duration: ${song.duration},`);
lines.push("  notes: decode(),");
lines.push("  lyrics: [],");
lines.push("  meta: [],");
lines.push(`  programs: [${progs ? "\n    " + progs + ",\n  " : ""}],`);
lines.push("};");
lines.push("");

writeFileSync("songData.ts", lines.join("\n"));
console.log(`wrote songData.ts (${((lines.join("\n").length) / 1024).toFixed(1)} KB, ${song.notes.length} notes)`);
