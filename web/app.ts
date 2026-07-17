/**
 * chiptune web player — drives the from-scratch synth engine in the browser.
 *
 * Strategy: OFFLINE RENDER then play. On load / any control change we call the
 * engine's render()/renderStereo() (the exact same Float32 pipeline the Node CLI
 * uses) to produce a stereo AudioBuffer, then play it through an
 * AudioBufferSourceNode with a small transport (play/pause/stop/seek). A ~196 s
 * song renders in a few seconds; the UI shows a "Rendering…" state meanwhile.
 */
import {
  render,
  renderStereo,
  DEFAULT_OPTS,
  FM_VOICES,
  SUB_VOICES,
  FORMANT_VOICES,
  KS_VOICES,
  type RenderOptions,
  type Voice,
} from "../synth.ts";
import { song as bundledSong } from "../songData.ts";
import { GM_NAMES } from "../gm.ts";
import { parseMidiBuffer } from "./browserMidi.ts";
import type { Song } from "../midiParse.ts";

const ENGINE_SR = 44100; // synth.ts internal sample rate

// ---- non-GM voice presets: each sets one timbre field of RenderOptions ----
type Preset = { name: string; timbre: Partial<Voice> };
const PRESETS: Preset[] = [
  { name: "Organ (sine + harmonics)", timbre: { harmonics: DEFAULT_OPTS.harmonics } },
  { name: "Pure sine", timbre: { harmonics: [] } },
  { name: "Rhodes (FM)", timbre: { fm: FM_VOICES.rhodes } },
  { name: "Bell (FM)", timbre: { fm: FM_VOICES.bell } },
  { name: "Brass (FM)", timbre: { fm: FM_VOICES.brass } },
  { name: "Pluck (subtractive)", timbre: { sub: SUB_VOICES.pluck } },
  { name: "Acid (subtractive)", timbre: { sub: SUB_VOICES.acid } },
  { name: "Strings (subtractive)", timbre: { sub: SUB_VOICES.strings } },
  { name: "Guitar (Karplus-Strong)", timbre: { ks: KS_VOICES.string } },
  { name: "Harp (Karplus-Strong)", timbre: { ks: KS_VOICES.harp } },
  { name: "Choir (formant)", timbre: { formant: FORMANT_VOICES.choir } },
  { name: "Vox (formant)", timbre: { formant: FORMANT_VOICES.vox } },
];

// ---- transport / render state ----
let ctx: AudioContext | null = null;
let song: Song = bundledSong;
let songName = "Chiptune demo (bundled)";
let audioBuffer: AudioBuffer | null = null;
let source: AudioBufferSourceNode | null = null;
let playing = false;
let offset = 0; // seconds into the buffer where playback (re)starts
let startedAt = 0; // ctx.currentTime at the last start()
let renderToken = 0; // guards against overlapping re-renders

// ---- DOM ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  file: $("file") as HTMLInputElement,
  songName: $("songName"),
  play: $("play") as HTMLButtonElement,
  stop: $("stop") as HTMLButtonElement,
  seek: $("seek") as HTMLInputElement,
  cur: $("cur"),
  dur: $("dur"),
  gm: $("gm") as HTMLInputElement,
  drums: $("drums") as HTMLInputElement,
  stereo: $("stereo") as HTMLInputElement,
  reverb: $("reverb") as HTMLInputElement,
  reverbMix: $("reverbMix") as HTMLInputElement,
  reverbMixVal: $("reverbMixVal"),
  voice: $("voice") as HTMLSelectElement,
  voiceRow: $("voiceRow"),
  status: $("status"),
  tracks: $("tracks"),
  roll: $("roll") as HTMLCanvasElement,
};

// populate voice preset picker
PRESETS.forEach((p, i) => {
  const o = document.createElement("option");
  o.value = String(i);
  o.textContent = p.name;
  els.voice.appendChild(o);
});

function fmtTime(s: number): string {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function buildOptions(): RenderOptions {
  const gm = els.gm.checked;
  const preset = PRESETS[Number(els.voice.value)] ?? PRESETS[0];
  const opts: RenderOptions = {
    attack: DEFAULT_OPTS.attack,
    release: DEFAULT_OPTS.release,
    harmonics: preset.timbre.harmonics ?? [],
    fm: preset.timbre.fm,
    sub: preset.timbre.sub,
    ks: preset.timbre.ks,
    formant: preset.timbre.formant,
    gm,
    drums: els.drums.checked,
    reverb: els.reverb.checked ? { room: 0.7, mix: Number(els.reverbMix.value) } : undefined,
  };
  return opts;
}

/** Render the current song+options to a stereo AudioBuffer (offline). */
async function rerender(): Promise<void> {
  const token = ++renderToken;
  const wasPlaying = playing;
  const resumeAt = currentTime();
  stopSource();

  els.status.textContent = "Rendering…";
  els.play.disabled = true;
  // yield so the browser paints the "Rendering…" state before the heavy sync work
  await new Promise((r) => setTimeout(r, 20));
  if (token !== renderToken) return; // superseded by a newer request

  const opts = buildOptions();
  const t0 = performance.now();
  let L: Float32Array;
  let R: Float32Array;
  if (els.stereo.checked) {
    [L, R] = renderStereo(song, opts);
  } else {
    L = render(song, opts);
    R = L;
  }
  const ms = Math.round(performance.now() - t0);
  if (token !== renderToken) return;

  if (!ctx) ctx = new AudioContext();
  const buf = ctx.createBuffer(2, L.length, ENGINE_SR);
  buf.getChannelData(0).set(L);
  buf.getChannelData(1).set(R);
  audioBuffer = buf;

  const dur = L.length / ENGINE_SR;
  els.seek.max = String(dur);
  els.dur.textContent = fmtTime(dur);
  els.status.textContent = `Ready — rendered ${dur.toFixed(1)}s in ${ms}ms`;
  els.play.disabled = false;

  offset = Math.min(resumeAt, dur);
  drawRoll();
  if (wasPlaying) startSource();
  else updateSeek();
}

function stopSource(): void {
  if (source) {
    source.onended = null;
    try {
      source.stop();
    } catch {}
    source.disconnect();
    source = null;
  }
  playing = false;
  els.play.textContent = "▶ Play";
}

function startSource(): void {
  if (!ctx || !audioBuffer) return;
  if (ctx.state === "suspended") ctx.resume();
  source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  source.onended = () => {
    if (playing) {
      // reached the end naturally
      stopSource();
      offset = 0;
      updateSeek();
    }
  };
  source.start(0, offset);
  startedAt = ctx.currentTime;
  playing = true;
  els.play.textContent = "⏸ Pause";
}

function currentTime(): number {
  if (!audioBuffer) return offset;
  const t = playing && ctx ? offset + (ctx.currentTime - startedAt) : offset;
  return Math.max(0, Math.min(t, audioBuffer.duration));
}

function togglePlay(): void {
  if (!audioBuffer) return;
  if (playing) {
    offset = currentTime();
    stopSource();
    updateSeek();
  } else {
    if (offset >= audioBuffer.duration - 0.01) offset = 0;
    startSource();
  }
}

function stopAll(): void {
  offset = 0;
  stopSource();
  updateSeek();
}

function updateSeek(): void {
  const t = currentTime();
  els.seek.value = String(t);
  els.cur.textContent = fmtTime(t);
  drawPlayhead(t);
}

// ---- piano-roll visualization ----
const CH_COLORS = [
  "#4cc9f0", "#4895ef", "#4361ee", "#3f37c9", "#7209b7", "#b5179e",
  "#f72585", "#ff6b6b", "#ff924c", "#ffca3a", "#8ac926", "#52b788",
  "#118ab2", "#06d6a0", "#c9ada7", "#e5989b",
];

function drawRoll(): void {
  const c = els.roll;
  const ctx2 = c.getContext("2d")!;
  const W = (c.width = c.clientWidth * devicePixelRatio);
  const H = (c.height = 220 * devicePixelRatio);
  ctx2.clearRect(0, 0, W, H);
  ctx2.fillStyle = "rgba(255,255,255,0.03)";
  ctx2.fillRect(0, 0, W, H);
  if (!audioBuffer) return;
  const dur = audioBuffer.duration;
  const pitched = song.notes.filter((n) => n.channel !== 9);
  if (pitched.length === 0) return;
  let lo = 127, hi = 0;
  for (const n of pitched) {
    if (n.pitch < lo) lo = n.pitch;
    if (n.pitch > hi) hi = n.pitch;
  }
  const range = Math.max(hi - lo, 1);
  const pad = 6 * devicePixelRatio;
  for (const n of pitched) {
    const x = (n.start / dur) * W;
    const w = Math.max((n.dur / dur) * W, 1.5 * devicePixelRatio);
    const y = pad + (1 - (n.pitch - lo) / range) * (H - 2 * pad);
    const h = Math.max((H - 2 * pad) / (range + 1), 2 * devicePixelRatio);
    ctx2.fillStyle = CH_COLORS[n.channel % 16];
    ctx2.globalAlpha = 0.85;
    ctx2.fillRect(x, y, w, h);
  }
  ctx2.globalAlpha = 1;
  drawPlayhead(currentTime());
}

let playheadX = 0;
function drawPlayhead(t: number): void {
  if (!audioBuffer) return;
  playheadX = (t / audioBuffer.duration) * els.roll.width;
}

// Animation loop: while playing, advance the transport readout and repaint the
// roll with a live playhead line on top of the static notes.
function frame(): void {
  if (playing && audioBuffer) {
    updateSeek();
    drawRoll();
    const ctx2 = els.roll.getContext("2d")!;
    ctx2.strokeStyle = "#fff";
    ctx2.lineWidth = 1.5 * devicePixelRatio;
    ctx2.beginPath();
    ctx2.moveTo(playheadX, 0);
    ctx2.lineTo(playheadX, els.roll.height);
    ctx2.stroke();
  }
  requestAnimationFrame(frame);
}

// ---- track / instrument listing ----
function listTracks(): void {
  els.songName.textContent = songName;
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const p of song.programs) {
    const key = `${p.track}:${p.channel}:${p.program}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const drum = p.channel === 9 ? " (drum ch)" : "";
    rows.push(
      `<tr><td>${p.track}</td><td>${p.channel + 1}${drum}</td><td>${p.program}</td><td>${GM_NAMES[p.program] ?? "?"}</td></tr>`,
    );
  }
  if (rows.length === 0) rows.push(`<tr><td colspan="4">No program changes (defaults to Acoustic Grand)</td></tr>`);
  els.tracks.innerHTML =
    `<table><thead><tr><th>Track</th><th>Ch</th><th>Prog</th><th>GM instrument</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

// ---- wiring ----
els.play.addEventListener("click", togglePlay);
els.stop.addEventListener("click", stopAll);
els.seek.addEventListener("input", () => {
  offset = Number(els.seek.value);
  els.cur.textContent = fmtTime(offset);
  if (playing) {
    stopSource();
    startSource();
  }
});
for (const ctl of [els.gm, els.drums, els.stereo, els.reverb, els.voice]) {
  ctl.addEventListener("change", () => {
    if (ctl === els.gm) els.voiceRow.style.display = els.gm.checked ? "none" : "flex";
    rerender();
  });
}
els.reverbMix.addEventListener("input", () => {
  els.reverbMixVal.textContent = Number(els.reverbMix.value).toFixed(2);
});
els.reverbMix.addEventListener("change", rerender);

els.file.addEventListener("change", async () => {
  const f = els.file.files?.[0];
  if (!f) return;
  try {
    const ab = await f.arrayBuffer();
    song = parseMidiBuffer(ab);
    songName = `${f.name} — ${song.notes.length} notes, ${song.duration.toFixed(1)}s @ ${song.tempoBpm} bpm`;
    stopAll();
    listTracks();
    await rerender();
  } catch (e) {
    els.status.textContent = `Failed to parse MIDI: ${(e as Error).message}`;
  }
});

// GM is on by default -> hide the non-GM voice picker initially
els.voiceRow.style.display = els.gm.checked ? "none" : "flex";
els.reverbMixVal.textContent = Number(els.reverbMix.value).toFixed(2);
listTracks();
requestAnimationFrame(frame);
rerender();
