/**
 * chiptune web player — drives the from-scratch synth engine LIVE in the browser
 * with just-in-time (JIT) block synthesis + buffering.
 *
 * Instead of rendering the whole song to an AudioBuffer up front, a
 * StreamingSynth (web/streamingSynth.ts) synthesizes the song a small block at a
 * time. A main-thread scheduler renders CHUNK-sized blocks slightly AHEAD of the
 * playback clock and queues them as precisely-scheduled AudioBufferSourceNodes
 * (gapless). This gives: instant start (no multi-second pre-render), instant
 * seek, and instrument / synth-param / mixer edits heard live — every change just
 * updates the synth's options/mixer and is picked up by the next block, no
 * re-render. (An AudioWorklet+SharedArrayBuffer path would avoid the main thread
 * entirely but needs COOP/COEP headers; this scheduler is robust here and hits
 * all the same properties — see WEB.md.)
 */
import {
  DEFAULT_OPTS,
  DEFAULT_FM,
  DEFAULT_SUB,
  DEFAULT_KS,
  DEFAULT_FORMANT,
  FM_VOICES,
  SUB_VOICES,
  FORMANT_VOICES,
  KS_VOICES,
  VOWELS,
  type RenderOptions,
  type Voice,
  type VoiceOverride,
  type Harmonic,
  type FmConfig,
  type SubConfig,
  type KsConfig,
  type FormantConfig,
} from "../synth.ts";
import { song as bundledSong } from "../songData.ts";
import { GM_NAMES, gmVoice } from "../gm.ts";
import { parseMidiBuffer } from "./browserMidi.ts";
import type { Song, Note } from "../midiParse.ts";
import { StreamingSynth, defaultChannelMix, PitchedVoice, MASTER_GAIN, type ChannelMix } from "./streamingSynth.ts";

type EngineType = "additive" | "fm" | "sub" | "ks" | "formant";

const ENGINE_SR = 44100;
const CHUNK = 2048; // ~46 ms synthesis block
const SCHEDULE_AHEAD = 0.2; // seconds of audio kept buffered ahead of the clock

// ---- non-GM voice presets (used when GM multi-instrument is off) ----
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

// ---- persisted per-song config ----
interface SongConfig {
  voiceOverrides: Record<string, VoiceOverride>;
  mixer: Record<string, ChannelMix>;
}

// ---- state ----
let ctx: AudioContext | null = null;
let song: Song = bundledSong;
let songName = "Chiptune demo (bundled)";
let songId = "";
let synth: StreamingSynth | null = null;

const voiceOverrides: Record<string, VoiceOverride> = {};
const mixer = new Map<string, ChannelMix>();
let chanInfos: ChanInfo[] = [];
let selectedKey: string | null = null;

let running = false;
let offset = 0; // seconds; where playback (re)starts
let anchorCtx = 0; // ctx.currentTime aligned to anchorPos
let anchorPos = 0; // playback seconds at anchorCtx
let nextTime = 0; // ctx time of the next chunk to schedule
let timer: number | null = null;
const scheduled = new Set<AudioBufferSourceNode>();

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
  compress: $("compress") as HTMLInputElement,
  reverb: $("reverb") as HTMLInputElement,
  reverbMix: $("reverbMix") as HTMLInputElement,
  reverbMixVal: $("reverbMixVal"),
  delay: $("delay") as HTMLInputElement,
  delayMix: $("delayMix") as HTMLInputElement,
  delayMixVal: $("delayMixVal"),
  voice: $("voice") as HTMLSelectElement,
  voiceRow: $("voiceRow"),
  status: $("status"),
  tracks: $("tracks"),
  cfgStatus: $("cfgStatus"),
  resetCfg: $("resetCfg") as HTMLButtonElement,
  saveCfg: $("saveCfg") as HTMLButtonElement,
  saveProject: $("saveProject") as HTMLButtonElement,
  projectFile: $("projectFile") as HTMLInputElement,
  instEditor: $("instEditor"),
  piano: $("piano"),
  midiStatus: $("midiStatus"),
  kbLayout: $("kbLayout") as HTMLSelectElement,
  octDown: $("octDown") as HTMLButtonElement,
  octUp: $("octUp") as HTMLButtonElement,
  octLabel: $("octLabel"),
  roll: $("roll") as HTMLCanvasElement,
};

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

// ---- options / voice resolution ----
function buildOptions(): RenderOptions {
  const gm = els.gm.checked;
  const preset = PRESETS[Number(els.voice.value)] ?? PRESETS[0];
  return {
    attack: DEFAULT_OPTS.attack,
    release: DEFAULT_OPTS.release,
    harmonics: preset.timbre.harmonics ?? [],
    fm: preset.timbre.fm,
    sub: preset.timbre.sub,
    ks: preset.timbre.ks,
    formant: preset.timbre.formant,
    gm,
    drums: els.drums.checked,
    reverb: els.reverb.checked ? { room: 0.82, mix: Number(els.reverbMix.value) } : undefined,
    delay: els.delay.checked ? { time: 0.32, feedback: 0.4, mix: Number(els.delayMix.value) } : undefined,
    compress: els.compress.checked ? { threshold: -18, ratio: 3, attack: 0.005, release: 0.12 } : undefined,
    voiceOverrides,
  };
}

/** Push the current options into the streaming synth (live, no re-render). */
function applyOptions(): void {
  if (synth) synth.setOptions(buildOptions());
}

// ---- channel discovery ----
interface ChanInfo { key: string; track: number; channel: number; program: number; isDrum: boolean; count: number; }
function channelsOf(s: Song): ChanInfo[] {
  const map = new Map<string, ChanInfo>();
  for (const n of s.notes) {
    const key = `${n.track}:${n.channel}`;
    let info = map.get(key);
    if (!info) {
      info = { key, track: n.track, channel: n.channel, program: 0, isDrum: n.channel === 9, count: 0 };
      // resolve the program in effect for the channel's first note
      let best = -1;
      for (const p of s.programs) {
        if (p.track === n.track && p.channel === n.channel && p.time <= n.start + 1e-6 && p.time >= best) {
          best = p.time;
          info.program = p.program;
        }
      }
      map.set(key, info);
    }
    info.count++;
  }
  return [...map.values()].sort((a, b) => a.track - b.track || a.channel - b.channel);
}

// A fresh channel mix. Reverb is OFF by default and only seeded from the MIDI's
// own CC91 reverb depth (never on drums) — the user then enables/adjusts it per
// track, which the mixer/.chip persists. So instruments that ask for reverb get
// it, drums stay dry, and nothing is drenched by default.
function newChannelMix(c: ChanInfo): ChannelMix {
  const m = defaultChannelMix();
  m.reverbSend = c.isDrum ? 0 : (song.reverb?.[c.key] ?? 0);
  return m;
}

// ---- persistence ----
function songHash(s: Song, name: string): string {
  let h = 2166136261 >>> 0;
  const mix = (x: number) => { h ^= x >>> 0; h = Math.imul(h, 16777619) >>> 0; };
  mix(s.notes.length);
  for (let i = 0; i < s.notes.length; i += Math.max(1, (s.notes.length / 256) | 0)) {
    const n = s.notes[i];
    mix((n.start * 1000) | 0); mix(n.pitch); mix(n.channel); mix(n.track);
  }
  return `${name.split(/[\s—]/)[0]}-${s.notes.length}-${(h >>> 0).toString(36)}`;
}
const cfgKey = (id: string) => `chiptune:cfg:${id}`;

function saveConfig(): void {
  const cfg: SongConfig = { voiceOverrides, mixer: Object.fromEntries(mixer) };
  try {
    localStorage.setItem(cfgKey(songId), JSON.stringify(cfg));
    els.cfgStatus.textContent = `Saved for “${songId}”`;
  } catch { /* storage full / disabled — ignore */ }
}

/** Coerce a persisted config's numeric fields back to numbers (a stray string
 *  from an older build or a hand-edited .chip must never reach `.toFixed`). */
function sanitizeConfig(cfg: SongConfig): SongConfig {
  const numFields = ["gain", "attack", "release", "foldAbove"] as const;
  for (const o of Object.values(cfg.voiceOverrides ?? {})) {
    for (const f of numFields) {
      const rec = o as Record<string, unknown>;
      if (rec[f] !== undefined) { const n = Number(rec[f]); if (Number.isFinite(n)) rec[f] = n; else delete rec[f]; }
    }
  }
  for (const m of Object.values(cfg.mixer ?? {})) {
    const rec = m as Record<string, unknown>;
    for (const f of ["volume", "reverbSend", "delaySend"]) {
      const n = Number(rec[f]); if (Number.isFinite(n)) rec[f] = n; else delete rec[f];
    }
  }
  return cfg;
}

function loadConfig(): boolean {
  for (const k of Object.keys(voiceOverrides)) delete voiceOverrides[k];
  mixer.clear();
  let loaded = false;
  try {
    const raw = localStorage.getItem(cfgKey(songId));
    if (raw) {
      const cfg = sanitizeConfig(JSON.parse(raw) as SongConfig);
      Object.assign(voiceOverrides, cfg.voiceOverrides ?? {});
      for (const [k, v] of Object.entries(cfg.mixer ?? {})) mixer.set(k, { ...defaultChannelMix(), ...v });
      loaded = true;
    }
  } catch { /* corrupt — fall through to defaults */ }
  // ensure every channel present in the song has a mixer strip
  for (const c of channelsOf(song)) if (!mixer.has(c.key)) mixer.set(c.key, newChannelMix(c));
  return loaded;
}

// ---- transport ----
function currentTime(): number {
  if (!running || !ctx) return offset;
  const t = anchorPos + (ctx.currentTime - anchorCtx);
  return Math.max(0, Math.min(t, song.duration));
}

function ensureCtx(): void {
  if (!ctx) ctx = new AudioContext({ sampleRate: ENGINE_SR, latencyHint: "interactive" });
  // An AudioContext starts `suspended` until a user gesture; resume() is a no-op
  // if already running. Without this, a note triggered from keydown is silent —
  // a keyboard-first user (who never clicked) would hear nothing at all. A
  // physical keydown *is* a user gesture, so resuming here unlocks it with no
  // prior click. resume() rejects if called without activation — swallow that.
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

function stopScheduled(): void {
  for (const s of scheduled) {
    try { s.onended = null; s.stop(); s.disconnect(); } catch { /* already stopped */ }
  }
  scheduled.clear();
}

function startPlayback(): void {
  ensureCtx();
  if (!synth || !ctx) return;
  synth.setMixer(mixer);
  synth.setOptions(buildOptions());
  synth.seek(Math.floor(offset * ENGINE_SR));
  anchorCtx = ctx.currentTime + 0.06;
  anchorPos = offset;
  nextTime = anchorCtx;
  running = true;
  els.play.textContent = "⏸ Pause";
  if (timer === null) timer = window.setInterval(tick, 20);
  tick();
}

function pausePlayback(): void {
  offset = currentTime();
  running = false;
  if (timer !== null) { clearInterval(timer); timer = null; }
  stopScheduled();
  els.play.textContent = "▶ Play";
  updateSeek();
}

function stopPlayback(): void {
  pausePlayback(); // stops sources; sets offset to the current position
  offset = 0; // ...then rewind to the start
  updateSeek();
}

function tick(): void {
  if (!running || !synth || !ctx) return;
  while (nextTime < ctx.currentTime + SCHEDULE_AHEAD) {
    // stop generating a little past the end (lets note releases finish)
    if (synth.playheadSeconds >= song.duration + 0.5) break;
    const [L, R] = synth.renderBlock(CHUNK);
    if (!els.stereo.checked) {
      for (let i = 0; i < CHUNK; i++) { const m = (L[i] + R[i]) * 0.5; L[i] = m; R[i] = m; }
    }
    const buf = ctx.createBuffer(2, CHUNK, ENGINE_SR);
    buf.copyToChannel(L, 0);
    buf.copyToChannel(R, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(nextTime);
    scheduled.add(src);
    src.onended = () => { scheduled.delete(src); try { src.disconnect(); } catch {} };
    nextTime += CHUNK / ENGINE_SR;
  }
  // keep the transport readout live even if requestAnimationFrame is throttled
  // (e.g. a backgrounded tab): the scheduler interval drives it too.
  updateSeek();
  if (currentTime() >= song.duration - 0.02 && synth && synth.playheadSeconds >= song.duration + 0.4) {
    stopPlayback();
  }
}

function togglePlay(): void {
  if (running) pausePlayback();
  else {
    if (offset >= song.duration - 0.01) offset = 0;
    startPlayback();
  }
}

function updateSeek(): void {
  const t = currentTime();
  els.seek.value = String(t);
  els.cur.textContent = fmtTime(t);
  drawPlayhead(t);
}

// ---- piano roll ----
const CH_COLORS = [
  "#4cc9f0", "#4895ef", "#4361ee", "#3f37c9", "#7209b7", "#b5179e",
  "#f72585", "#ff6b6b", "#ff924c", "#ffca3a", "#8ac926", "#52b788",
  "#118ab2", "#06d6a0", "#c9ada7", "#e5989b",
];
let playheadT = 0; // seconds — the transport position the playhead marks
function drawRoll(): void {
  const c = els.roll;
  const g = c.getContext("2d")!;
  // clientWidth can be 0 if we draw before layout (initial load) — fall back so
  // the roll is never a zero-width (invisible) canvas.
  const cw = c.clientWidth || c.parentElement?.clientWidth || 800;
  const W = (c.width = cw * devicePixelRatio);
  const H = (c.height = 220 * devicePixelRatio);
  g.clearRect(0, 0, W, H);
  g.fillStyle = "rgba(255,255,255,0.03)";
  g.fillRect(0, 0, W, H);
  const dur = song.duration;
  const pitched = song.notes.filter((n) => n.channel !== 9);
  if (pitched.length && dur > 0) {
    let lo = 127, hi = 0;
    for (const n of pitched) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; }
    const range = Math.max(hi - lo, 1);
    const pad = 6 * devicePixelRatio;
    const solo = [...mixer.values()].some((m) => m.solo);
    for (const n of pitched) {
      const m = mixer.get(`${n.track}:${n.channel}`);
      const silent = m && (solo ? !m.solo : m.mute);
      const x = (n.start / dur) * W;
      const w = Math.max((n.dur / dur) * W, 1.5 * devicePixelRatio);
      const y = pad + (1 - (n.pitch - lo) / range) * (H - 2 * pad);
      const h = Math.max((H - 2 * pad) / (range + 1), 2 * devicePixelRatio);
      g.fillStyle = CH_COLORS[n.channel % 16];
      g.globalAlpha = silent ? 0.18 : 0.85;
      g.fillRect(x, y, w, h);
    }
    g.globalAlpha = 1;
    // transport playhead — always drawn (paused too), not just while playing
    const px = (playheadT / dur) * W;
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5 * devicePixelRatio;
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, H);
    g.stroke();
  }
}
/** Move the playhead to `t` seconds and redraw. */
function drawPlayhead(t: number): void {
  playheadT = t;
  drawRoll();
}
// Highlight (class `playing`) the on-screen keys of the selected channel's notes
// that are sounding at transport time `t`. Cleared when stopped / no selection.
let playingPitches = new Set<number>();
function updatePlayingKeys(t: number): void {
  const next = new Set<number>();
  if (running && selectedKey) {
    for (const n of song.notes) {
      if (`${n.track}:${n.channel}` !== selectedKey) continue;
      if (n.start <= t && t < n.start + n.dur) next.add(n.pitch);
    }
  }
  for (const p of playingPitches) if (!next.has(p)) keyEl(p)?.classList.remove("playing");
  for (const p of next) if (!playingPitches.has(p)) keyEl(p)?.classList.add("playing");
  playingPitches = next;
}
function frame(): void {
  if (running) {
    updateSeek();
    if (currentTime() >= song.duration - 0.02 && synth && synth.playheadSeconds >= song.duration + 0.4) {
      stopPlayback();
    }
    drawPlayhead(currentTime());
  }
  updatePlayingKeys(currentTime());
  requestAnimationFrame(frame);
}
// redraw on resize, and once after first layout (initial canvas width may be 0)
addEventListener("resize", () => drawRoll());
requestAnimationFrame(() => drawPlayhead(offset));

// ---- mixer / instrument editor table ----
function buildEditor(): void {
  els.songName.textContent = songName;
  const chans = channelsOf(song);
  chanInfos = chans;
  const gmOptions = GM_NAMES.map((nm, i) => `<option value="${i}">${i} ${nm}</option>`).join("");

  const rows = chans.map((c) => {
    const m = mixer.get(c.key)!;
    const ov = voiceOverrides[c.key];
    const prog = ov?.program ?? c.program;
    const gRaw = Number(ov?.gain ?? 1);
    const gain = Number.isFinite(gRaw) ? gRaw : 1; // never let a bad value crash .toFixed
    const inst = c.isDrum
      ? `<span class="filelabel">Drum kit</span>`
      : `<select data-k="${c.key}" data-f="program">${gmOptions}</select>`;
    return `<tr data-key="${c.key}">
      <td>${c.track}</td>
      <td>${c.channel + 1}${c.isDrum ? " (drum)" : ""}</td>
      <td>${inst}</td>
      <td><input type="range" data-k="${c.key}" data-f="gain" min="0.1" max="2" step="0.05" value="${gain}" ${c.isDrum ? "disabled" : ""}/><span class="cellval" id="gain-${c.key}">${gain.toFixed(2)}</span></td>
      <td><input type="range" data-k="${c.key}" data-f="volume" min="0" max="1" step="0.02" value="${m.volume}"/><span class="cellval" id="vol-${c.key}">${m.volume.toFixed(2)}</span></td>
      <td><button class="mixbtn ${m.mute ? "on-mute" : ""}" data-k="${c.key}" data-f="mute">M</button></td>
      <td><button class="mixbtn ${m.solo ? "on-solo" : ""}" data-k="${c.key}" data-f="solo">S</button></td>
      <td><input type="range" data-k="${c.key}" data-f="reverbSend" min="0" max="1" step="0.05" value="${m.reverbSend}"/><span class="cellval" id="rev-${c.key}">${m.reverbSend.toFixed(2)}</span></td>
      <td><input type="range" data-k="${c.key}" data-f="delaySend" min="0" max="1" step="0.05" value="${m.delaySend}"/><span class="cellval" id="del-${c.key}">${m.delaySend.toFixed(2)}</span></td>
      <td><button class="editbtn ${selectedKey === c.key ? "editing" : ""}" data-k="${c.key}" data-f="edit"${c.isDrum ? " disabled" : ""}>Edit</button></td>
    </tr>`;
  });

  els.tracks.innerHTML = `<table><thead><tr>
    <th>Trk</th><th>Ch</th><th>Instrument (GM)</th><th>Gain</th><th>Volume</th><th>Mute</th><th>Solo</th><th>Rev send</th><th>Dly send</th><th></th>
  </tr></thead><tbody>${rows.join("")}</tbody></table>`;

  // set each GM <select> to the current program
  for (const c of chans) {
    if (c.isDrum) continue;
    const sel = els.tracks.querySelector<HTMLSelectElement>(`select[data-k="${c.key}"][data-f="program"]`);
    if (sel) sel.value = String(voiceOverrides[c.key]?.program ?? c.program);
  }
}

function ov(key: string): VoiceOverride {
  return (voiceOverrides[key] ??= {});
}

els.tracks.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  const key = t.dataset.k, field = t.dataset.f;
  if (!key || !field) return;
  const val = Number(t.value);
  const m = mixer.get(key)!;
  if (field === "gain") { ov(key).gain = val; ($(`gain-${key}`) as HTMLElement).textContent = val.toFixed(2); applyOptions(); }
  else if (field === "volume") { m.volume = val; ($(`vol-${key}`) as HTMLElement).textContent = val.toFixed(2); }
  else if (field === "reverbSend") { m.reverbSend = val; ($(`rev-${key}`) as HTMLElement).textContent = val.toFixed(2); }
  else if (field === "delaySend") { m.delaySend = val; ($(`del-${key}`) as HTMLElement).textContent = val.toFixed(2); }
  saveConfig();
});

els.tracks.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.dataset.f === "program") {
    ov(t.dataset.k!).program = Number(t.value);
    applyOptions();
    saveConfig();
  }
});

els.tracks.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const edit = target.closest("button.editbtn") as HTMLButtonElement | null;
  if (edit) { selectChannel(edit.dataset.k!); return; }
  const b = target.closest("button.mixbtn") as HTMLButtonElement | null;
  if (!b) return;
  const key = b.dataset.k!, field = b.dataset.f!;
  const m = mixer.get(key)!;
  if (field === "mute") { m.mute = !m.mute; b.classList.toggle("on-mute", m.mute); }
  else if (field === "solo") { m.solo = !m.solo; b.classList.toggle("on-solo", m.solo); }
  saveConfig();
});

// ---- instrument editor ----
function engineOf(v: Voice): EngineType {
  if (v.ks) return "ks";
  if (v.formant) return "formant";
  if (v.sub) return "sub";
  if (v.fm) return "fm";
  return "additive";
}

/** Effective voice for a channel: GM program merged with its VoiceOverride. */
function resolveVoice(key: string): { voice: Voice; engine: EngineType; program: number; isDrum: boolean } {
  const info = chanInfos.find((c) => c.key === key);
  const isDrum = info?.isDrum ?? false;
  const ov = voiceOverrides[key];
  const prog = ov?.program ?? info?.program ?? 0;
  let v: Voice = { ...gmVoice(prog) };
  if (ov) {
    const engineKeys: (keyof VoiceOverride)[] = ["harmonics", "fm", "sub", "ks", "formant"];
    if (engineKeys.some((k) => ov[k] !== undefined)) {
      // engine swap clears the other engine fields, but keep the non-engine
      // stages the streaming path (gmVoiceFor) preserves, so preview == playback.
      v = { attack: v.attack, release: v.release, gain: v.gain, foldAbove: v.foldAbove, sympathetic: v.sympathetic, amp: v.amp };
    }
    v = { ...v, ...ov };
    delete (v as Partial<VoiceOverride>).program;
  }
  return { voice: v, engine: engineOf(v), program: prog, isDrum };
}

function selectChannel(key: string): void {
  selectedKey = key;
  for (const b of els.tracks.querySelectorAll("button.editbtn")) {
    b.classList.toggle("editing", (b as HTMLElement).dataset.k === key);
  }
  renderInstrumentEditor();
}

const NUM = (label: string, key: string, field: string, sub: string, val: number, min: number, max: number, step: number) =>
  `<div class="fld"><label>${label}</label><div class="rowin">
     <input type="range" data-ie="1" data-k="${key}" data-f="${field}" data-s="${sub}" min="${min}" max="${max}" step="${step}" value="${val}"/>
     <span class="cellval" data-out="${field}.${sub}">${val}</span></div></div>`;

function renderInstrumentEditor(): void {
  if (!selectedKey) { els.instEditor.innerHTML = `<span class="filelabel">Click "Edit" on a channel above to edit its instrument voice.</span>`; return; }
  const key = selectedKey;
  const info = chanInfos.find((c) => c.key === key);
  const { voice, engine } = resolveVoice(key);
  const gmName = GM_NAMES[voiceOverrides[key]?.program ?? info?.program ?? 0];

  const common = `<div class="grid">
    ${NUM("Attack (ms)", key, "attack", "", Math.round((voice.attack ?? 0.005) * 1000), 0, 500, 1)}
    ${NUM("Release (ms)", key, "release", "", Math.round((voice.release ?? 0.03) * 1000), 0, 1000, 1)}
    ${NUM("Gain", key, "gain", "", +(voice.gain ?? 1).toFixed(2), 0.1, 3, 0.05)}
    ${NUM("Fold above (0=off)", key, "foldAbove", "", voice.foldAbove ?? 0, 0, 108, 1)}
  </div>`;

  const engineSel = `<div class="fld" style="max-width:220px"><label>Synthesis engine</label>
    <select id="engineSel">
      ${(["additive", "fm", "sub", "ks", "formant"] as EngineType[]).map((e) => `<option value="${e}" ${e === engine ? "selected" : ""}>${e}</option>`).join("")}
    </select></div>`;

  let params = "";
  if (engine === "additive") {
    const hs = voice.harmonics ?? [];
    params = `<h3>Additive harmonics</h3>
      <div id="harmList">${hs.map((h, i) => harmRow(i, h)).join("")}</div>
      <div class="row" style="margin-top:6px"><button id="harmAdd" style="padding:2px 10px;font-size:12px">+ add harmonic</button></div>`;
  } else if (engine === "fm") {
    const f = voice.fm!;
    params = `<h3>FM</h3><div class="grid">
      ${NUM("Ratio", key, "fm", "ratio", f.ratio, 0.1, 12, 0.1)}
      ${NUM("Index", key, "fm", "index", f.index, 0, 20, 0.1)}
      ${NUM("Decay (s)", key, "fm", "decay", f.decay, 0.02, 4, 0.02)}
      ${NUM("Sustain", key, "fm", "sustain", f.sustain, 0, 1, 0.05)}
    </div>`;
  } else if (engine === "sub") {
    const s = voice.sub!;
    params = `<h3>Subtractive</h3>
      <div class="fld" style="max-width:200px"><label>Wave</label>
        <select data-ie="1" data-k="${key}" data-f="sub" data-s="wave">
          <option value="saw" ${s.wave === "saw" ? "selected" : ""}>saw</option>
          <option value="square" ${s.wave === "square" ? "selected" : ""}>square</option>
        </select></div>
      <div class="grid">
      ${NUM("Cutoff (Hz)", key, "sub", "cutoff", s.cutoff, 50, 6000, 10)}
      ${NUM("Resonance", key, "sub", "resonance", s.resonance, 0, 0.98, 0.02)}
      ${NUM("Env amount (Hz)", key, "sub", "envAmount", s.envAmount, 0, 6000, 50)}
      ${NUM("Env decay (s)", key, "sub", "envDecay", s.envDecay, 0.02, 2, 0.02)}
      ${NUM("Detune (cents)", key, "sub", "detune", s.detune, 0, 40, 1)}
      ${NUM("Unison voices", key, "sub", "voices", s.voices, 1, 7, 1)}
      ${NUM("Drive (distortion)", key, "sub", "drive", s.drive ?? 1, 1, 30, 0.5)}
    </div>`;
  } else if (engine === "ks") {
    const k = voice.ks!;
    params = `<h3>Karplus–Strong (string)</h3><div class="grid">
      ${NUM("Decay", key, "ks", "decay", k.decay, 0.9, 0.9999, 0.001)}
      ${NUM("Damping", key, "ks", "damping", k.damping, 0, 1, 0.02)}
      ${NUM("Body", key, "ks", "body", k.body ?? 0, 0, 0.6, 0.02)}
      ${NUM("Stiffness (inharmonic)", key, "ks", "stiffness", k.stiffness ?? 0, 0, 1, 0.02)}
      ${NUM("Pick position", key, "ks", "pick", k.pick ?? 0, 0, 0.5, 0.02)}
      ${NUM("Pick hardness (tone)", key, "ks", "tone", k.tone ?? 1, 0, 1, 0.02)}
    </div>`;
  } else {
    const fo = voice.formant!;
    params = `<h3>Formant (vocal)</h3>
      <div class="fld" style="max-width:200px"><label>Vowel</label>
        <select data-ie="1" data-k="${key}" data-f="formant" data-s="vowel">
          ${["a", "e", "i", "o", "u", "a>o", "a>i", "o>a"].map((vw) => `<option ${fo.vowel === vw ? "selected" : ""}>${vw}</option>`).join("")}
        </select></div>
      <div class="grid">
      ${NUM("Voices", key, "formant", "voices", fo.voices, 1, 6, 1)}
      ${NUM("Detune (cents)", key, "formant", "detune", fo.detune, 0, 40, 1)}
    </div>`;
  }

  const sy = voice.sympathetic;
  const symHtml = `<h3>Sympathetic strings</h3><div class="grid">
      ${NUM("Ring amount (mix)", key, "sympathetic", "mix", sy?.mix ?? 0, 0, 0.6, 0.02)}
      ${NUM("Ring time", key, "sympathetic", "feedback", sy?.feedback ?? 0.55, 0, 0.95, 0.02)}
    </div><span class="filelabel">The instrument's own open strings ringing along (guitar-tuned by default). 0 = off.</span>`;

  const am = voice.amp;
  const ampHtml = `<h3>Amp / cabinet (electric)</h3><div class="grid">
      ${NUM("Drive", key, "amp", "drive", am?.drive ?? 1, 1, 5, 0.1)}
      ${NUM("Presence", key, "amp", "presence", am?.presence ?? 0, 0, 1, 0.05)}
      ${NUM("Cab cutoff (Hz)", key, "amp", "cabLow", am?.cabLow ?? 20000, 1500, 20000, 100)}
      ${NUM("Level", key, "amp", "level", am?.level ?? 1, 0, 2, 0.05)}
    </div><span class="filelabel">Speaker-cabinet + tube voicing (makes a string read as a clean electric). Cutoff 20000 + drive 1 = effectively off.</span>`;

  els.instEditor.innerHTML =
    `<div class="row"><strong>Track ${info?.track} · Ch ${(info?.channel ?? 0) + 1}</strong>
       <span class="filelabel">GM: ${gmName} — change instrument or engine, edits are heard live &amp; on the keyboard below.</span></div>
     ${engineSel}${common}${params}${symHtml}${ampHtml}`;
}

function harmRow(i: number, h: Harmonic): string {
  return `<div class="hrow" data-i="${i}">
    <label class="filelabel">×</label><input type="number" data-harm="mult" data-i="${i}" min="1" max="16" step="1" value="${h.multiple}"/>
    <label class="filelabel">amp</label><input type="number" data-harm="amp" data-i="${i}" min="0" max="1" step="0.05" value="${h.amp}"/>
    <button data-harm="del" data-i="${i}" style="padding:1px 8px;font-size:12px">×</button></div>`;
}

/** Read the override object for editing (create if absent). */
function ovForEdit(key: string): VoiceOverride { return (voiceOverrides[key] ??= {}); }

/** Ensure the override carries a full engine config to mutate (seed from resolved voice). */
function currentEngineConfig(key: string, engine: EngineType): FmConfig | SubConfig | KsConfig | FormantConfig | Harmonic[] {
  const { voice } = resolveVoice(key);
  if (engine === "fm") return { ...(voice.fm ?? DEFAULT_FM) };
  if (engine === "sub") return { ...(voice.sub ?? DEFAULT_SUB) };
  if (engine === "ks") return { ...(voice.ks ?? DEFAULT_KS) };
  if (engine === "formant") return { ...(voice.formant ?? DEFAULT_FORMANT) };
  return (voice.harmonics ?? DEFAULT_OPTS.harmonics).map((h) => ({ ...h }));
}

// instrument-editor input/change handlers (range sliders + selects)
els.instEditor.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.ie !== "1") return;
  const key = t.dataset.k!, field = t.dataset.f!, sub = t.dataset.s!;
  const ov = ovForEdit(key);
  const out = els.instEditor.querySelector<HTMLElement>(`[data-out="${field}.${sub}"]`);
  if (field === "attack") { ov.attack = Number(t.value) / 1000; }
  else if (field === "release") { ov.release = Number(t.value) / 1000; }
  else if (field === "gain") { ov.gain = Number(t.value); }
  else if (field === "foldAbove") { const n = Number(t.value); if (n <= 0) delete ov.foldAbove; else ov.foldAbove = n; }
  else if (field === "sympathetic") {
    // the instrument's own strings ringing along; seed strings/damping from the
    // current voice (guitar open strings if none), edit only mix / ring-time here.
    const base = ov.sympathetic ?? resolveVoice(key).voice.sympathetic ?? { strings: [40, 45, 50, 55, 59, 64], feedback: 0.55, damping: 0.35, mix: 0 };
    ov.sympathetic = { ...base, [sub]: Number(t.value) };
  }
  else if (field === "amp") {
    const base = ov.amp ?? resolveVoice(key).voice.amp ?? { drive: 1, presence: 0, cabLow: 20000, level: 1 };
    ov.amp = { ...base, [sub]: Number(t.value) };
  }
  else {
    // engine param: mutate a copy of the full engine config
    const engine = field as EngineType;
    const cfg = currentEngineConfig(key, engine) as Record<string, unknown>;
    cfg[sub] = t.type === "range" || t.tagName === "INPUT" ? Number(t.value) : t.value;
    if (t.dataset.s === "wave" || (field === "formant" && sub === "vowel")) cfg[sub] = t.value;
    setEngineOverride(ov, engine, cfg);
  }
  if (out) out.textContent = t.value;
  applyOptions();
  saveConfig();
});
els.instEditor.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.id === "engineSel") { switchEngine(selectedKey!, t.value as EngineType); return; }
  if (t.dataset.ie !== "1") return; // selects (wave / vowel)
  const key = t.dataset.k!, field = t.dataset.f! as EngineType, sub = t.dataset.s!;
  const cfg = currentEngineConfig(key, field) as Record<string, unknown>;
  cfg[sub] = t.value;
  setEngineOverride(ovForEdit(key), field, cfg);
  applyOptions();
  saveConfig();
});
// harmonics add/remove/edit
els.instEditor.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  const kind = t.dataset.harm;
  if (kind !== "mult" && kind !== "amp") return;
  updateHarmonics();
});
els.instEditor.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "harmAdd") {
    const list = document.getElementById("harmList")!;
    const i = list.children.length;
    list.insertAdjacentHTML("beforeend", harmRow(i, { multiple: i + 2, amp: 0.2 }));
    updateHarmonics();
  } else if (t.dataset.harm === "del") {
    t.closest(".hrow")!.remove();
    updateHarmonics();
  }
});
function updateHarmonics(): void {
  if (!selectedKey) return;
  const harmonics: Harmonic[] = [];
  for (const row of document.querySelectorAll("#harmList .hrow")) {
    const mult = Number(row.querySelector<HTMLInputElement>('[data-harm="mult"]')!.value);
    const amp = Number(row.querySelector<HTMLInputElement>('[data-harm="amp"]')!.value);
    harmonics.push({ multiple: mult, amp });
  }
  const ov = ovForEdit(selectedKey);
  delete ov.fm; delete ov.sub; delete ov.ks; delete ov.formant;
  ov.harmonics = harmonics;
  applyOptions();
  saveConfig();
}

function setEngineOverride(ov: VoiceOverride, engine: EngineType, cfg: unknown): void {
  delete ov.harmonics; delete ov.fm; delete ov.sub; delete ov.ks; delete ov.formant;
  if (engine === "additive") ov.harmonics = cfg as Harmonic[];
  else (ov as Record<string, unknown>)[engine] = cfg;
}

function switchEngine(key: string, engine: EngineType): void {
  const ov = ovForEdit(key);
  const seed = currentEngineConfig(key, engine);
  setEngineOverride(ov, engine, engine === "additive" ? (seed as Harmonic[]) : seed);
  applyOptions();
  saveConfig();
  renderInstrumentEditor();
}

// ---- on-screen piano + audition ----
// The piano spans ~2.4 octaves around middle C. `octaveShift` (in whole octaves)
// pans that window lower/higher: every rendered key's data-pitch — and the
// computer-keyboard map — moves by ±12 per octave, so both stay in lockstep.
const PIANO_LO = 48, PIANO_HI = 76; // C3..E5 at octaveShift 0 (middle C centred)
const BLACK = new Set([1, 3, 6, 8, 10]);
const OCT_MIN = -3, OCT_MAX = 3; // keeps every pitch within MIDI 0..127
const OCT_KEY = "chiptune:octaveShift";
let octaveShift = 0;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function noteName(m: number): string { return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`; }
function buildPiano(): void {
  let html = "";
  for (let p = PIANO_LO; p <= PIANO_HI; p++) {
    const pitch = p + octaveShift * 12;
    if (pitch < 0 || pitch > 127) continue;
    const black = BLACK.has(pitch % 12);
    html += `<span class="pkey${black ? " black" : ""}" data-pitch="${pitch}"></span>`;
  }
  els.piano.innerHTML = html;
}
/** Center note the map plays with no key held (middle C at shift 0). */
function updateOctLabel(): void { els.octLabel.textContent = `Center ${noteName(60 + octaveShift * 12)}`; }
/** Release every held live voice + clear held keys — avoids stuck notes when the
 *  octave changes mid-hold (the keyup would target the new, un-held pitch). */
function releaseAllLive(): void {
  for (const p of [...liveVoices.keys()]) noteOff(p);
  held.clear();
  pointerPitch = null;
}
function setOctaveShift(v: number): void {
  const nv = Math.max(OCT_MIN, Math.min(OCT_MAX, v));
  if (nv === octaveShift) return;
  releaseAllLive();
  octaveShift = nv;
  buildPiano();
  updateOctLabel();
  try { localStorage.setItem(OCT_KEY, String(octaveShift)); } catch { /* storage disabled */ }
}
function keyEl(pitch: number): HTMLElement | null {
  return els.piano.querySelector(`[data-pitch="${pitch}"]`);
}
// Sustaining audition: a note is held for as long as the key/pointer is down.
// A single persistent real-time ScriptProcessor sums the currently-held live
// voices and writes them straight to the output — no pre-render, no 8 s cap, so
// latency is ~the buffer size and a held note rings indefinitely. Each voice is
// the exact same stateful PitchedVoice DSP the song path uses.
const LIVE_BUF = 256; // frames per callback (~6 ms @ 44.1 kHz) -> low latency
const liveVoices = new Map<number, PitchedVoice>();
let liveNode: ScriptProcessorNode | null = null;
let liveScratch = new Float32Array(LIVE_BUF);
function ensureLiveNode(): void {
  if (liveNode || !ctx) return;
  const node = ctx.createScriptProcessor(LIVE_BUF, 0, 2);
  node.onaudioprocess = (e: AudioProcessingEvent) => {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const N = outL.length;
    // Sum held voices into outL (mono), then fan out to stereo below.
    outL.fill(0);
    if (liveVoices.size > 0) {
      if (liveScratch.length < N) liveScratch = new Float32Array(N);
      const scratch = liveScratch;
      for (const [pitch, v] of liveVoices) {
        v.render(scratch, 0, N);
        for (let i = 0; i < N; i++) outL[i] += scratch[i];
        if (v.done) { liveVoices.delete(pitch); keyEl(pitch)?.classList.remove("down"); }
      }
    }
    // Master gain + guard: a single NaN reaching the destination poisons the
    // whole AudioContext, so force finite, then soft-clamp to [-1, 1].
    for (let i = 0; i < N; i++) {
      let s = outL[i] * MASTER_GAIN;
      if (!Number.isFinite(s)) s = 0;
      else if (s > 1) s = 1;
      else if (s < -1) s = -1;
      outL[i] = s;
      outR[i] = s;
    }
  };
  node.connect(ctx.destination);
  liveNode = node;
}
function noteOn(pitch: number, velocity = 100): void {
  ensureCtx();
  if (!ctx) return;
  ensureLiveNode();
  const voice = selectedKey ? resolveVoice(selectedKey).voice : gmVoice(0);
  // Very long duration -> the voice sustains at its sustain level until release().
  const note: Note = { start: 0, dur: 3600, pitch, velocity, channel: 0, track: 0 };
  const v = new PitchedVoice(note, voice, buildOptions().vibrato, "audition", 0);
  liveVoices.set(pitch, v); // overwrite -> retrigger if already held
  keyEl(pitch)?.classList.add("down");
}
function noteOff(pitch: number): void {
  const v = liveVoices.get(pitch);
  if (!v) return;
  v.release(); // begin release ramp; the callback removes it once the tail ends
  keyEl(pitch)?.classList.remove("down");
}
/** One-shot audition (used by live MIDI note-ons and anywhere a hold isn't tracked). */
function audition(pitch: number, velocity = 100): void {
  noteOn(pitch, velocity);
  setTimeout(() => noteOff(pitch), 400);
}
let pointerPitch: number | null = null;
els.piano.addEventListener("pointerdown", (e) => {
  const t = (e.target as HTMLElement).closest(".pkey") as HTMLElement | null;
  if (!t) return;
  e.preventDefault();
  pointerPitch = Number(t.dataset.pitch);
  noteOn(pointerPitch);
});
// glissando: while the button is held, sliding onto a different key stops the
// old note and starts the new one (robust if the pointer leaves the piano).
els.piano.addEventListener("pointermove", (e) => {
  if (pointerPitch === null) return;
  const under = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(".pkey")
    ?? (e.target as HTMLElement).closest(".pkey");
  const t = under as HTMLElement | null;
  if (!t) return;
  const p = Number(t.dataset.pitch);
  if (p !== pointerPitch) { noteOff(pointerPitch); noteOn(p); pointerPitch = p; }
});
window.addEventListener("pointerup", () => {
  if (pointerPitch !== null) { noteOff(pointerPitch); pointerPitch = null; }
});

// computer-keyboard mapping (one octave from middle C). `e.key` is layout-
// dependent — on AZERTY the physical keys at the QWERTY a/w positions emit q/z —
// so we keep one map per layout and pick the active one by the selected layout.
const KEYMAPS: Record<string, Record<string, number>> = {
  qwerty: { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72 },
  azerty: { q: 60, z: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72 },
};
const KB_LAYOUT_KEY = "chiptune:kbLayout";
function activeKeymap(): Record<string, number> {
  return KEYMAPS[els.kbLayout.value] ?? KEYMAPS.qwerty;
}
/** MIDI pitch a letter key plays: the map's center-octave pitch + octave shift. */
function keymapPitch(key: string): number | undefined {
  const base = activeKeymap()[key];
  return base === undefined ? undefined : base + octaveShift * 12;
}
// restore the persisted layout choice (default QWERTY)
try {
  const saved = localStorage.getItem(KB_LAYOUT_KEY);
  if (saved && KEYMAPS[saved]) els.kbLayout.value = saved;
} catch { /* storage disabled — keep default */ }
els.kbLayout.addEventListener("change", () => {
  try { localStorage.setItem(KB_LAYOUT_KEY, els.kbLayout.value); } catch {}
});
// octave shift — buttons move both the on-screen piano and the computer keys
els.octDown.addEventListener("click", () => setOctaveShift(octaveShift - 1));
els.octUp.addEventListener("click", () => setOctaveShift(octaveShift + 1));
// restore the persisted octave choice (default 0 = middle C centred)
try {
  const saved = Number(localStorage.getItem(OCT_KEY));
  if (Number.isFinite(saved)) octaveShift = Math.max(OCT_MIN, Math.min(OCT_MAX, saved | 0));
} catch { /* storage disabled — keep default */ }

/** True when a form control has focus, so typing shouldn't play notes. */
function inField(): boolean {
  const el = document.activeElement;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}
const held = new Set<string>();
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = inField();
  // spacebar = play/stop (unless typing in a field, where space is a space)
  if (e.key === " " && !typing) {
    e.preventDefault();
    togglePlay();
    return;
  }
  // transport seek shortcuts (not when typing in a field)
  if (!typing) {
    const t = currentTime();
    switch (e.key) {
      case "Home": e.preventDefault(); seekTo(0); return;
      case "End": e.preventDefault(); seekTo(song.duration); return;
      case "ArrowLeft": e.preventDefault(); seekTo(t - 5); return;
      case "ArrowRight": e.preventDefault(); seekTo(t + 5); return;
      case "PageUp": e.preventDefault(); seekTo(t - 20); return;
      case "PageDown": e.preventDefault(); seekTo(t + 20); return;
      // octave shift for both the on-screen piano and the computer keys
      case "-": case "_": e.preventDefault(); setOctaveShift(octaveShift - 1); return;
      case "=": case "+": e.preventDefault(); setOctaveShift(octaveShift + 1); return;
    }
  }
  if (typing) return;
  const key = e.key.toLowerCase();
  const p = keymapPitch(key);
  if (p === undefined || held.has(key)) return;
  held.add(key);
  noteOn(p); // held until keyup
});
window.addEventListener("keyup", (e) => {
  const key = e.key.toLowerCase();
  if (held.delete(key)) {
    const p = keymapPitch(key);
    if (p !== undefined) noteOff(p);
  }
});

// Web MIDI (guarded — many environments lack it)
function initMidi(): void {
  const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> };
  if (!nav.requestMIDIAccess) { els.midiStatus.textContent = "MIDI: not supported here"; return; }
  nav.requestMIDIAccess().then((access) => {
    const wire = () => {
      let n = 0;
      for (const input of access.inputs.values()) { input.onmidimessage = onMidi; n++; }
      els.midiStatus.textContent = n ? `MIDI: ${n} input(s) connected` : "MIDI: no device";
    };
    wire();
    access.onstatechange = wire;
  }).catch(() => { els.midiStatus.textContent = "MIDI: permission denied"; });
}
function onMidi(e: MIDIMessageEvent): void {
  const [status, pitch, vel] = e.data as unknown as [number, number, number];
  if ((status & 0xf0) === 0x90 && vel > 0) audition(pitch, vel);
}

// ---- song lifecycle ----
function openSong(newSong: Song, name: string, preset?: SongConfig): void {
  song = newSong;
  songName = name;
  songId = songHash(song, name);
  offset = 0;
  let had: boolean;
  if (preset) {
    sanitizeConfig(preset);
    for (const k of Object.keys(voiceOverrides)) delete voiceOverrides[k];
    mixer.clear();
    Object.assign(voiceOverrides, preset.voiceOverrides ?? {});
    for (const [k, v] of Object.entries(preset.mixer ?? {})) mixer.set(k, { ...defaultChannelMix(), ...v });
    for (const c of channelsOf(song)) if (!mixer.has(c.key)) mixer.set(c.key, newChannelMix(c));
    saveConfig(); // persist the loaded project under its song id
    had = true;
  } else {
    had = loadConfig();
  }
  // solo/mute are transient performance state — never carry them across a load,
  // or a persisted solo silences everything else and looks broken on refresh.
  for (const m of mixer.values()) { m.solo = false; m.mute = false; }
  synth = new StreamingSynth(song, buildOptions());
  synth.setMixer(mixer);
  els.seek.max = String(song.duration);
  els.dur.textContent = fmtTime(song.duration);
  els.cfgStatus.textContent = had ? `Loaded saved config for “${songId}”` : `New song “${songId}” (defaults)`;
  els.status.textContent = `Ready — streaming, ${song.notes.length} notes, ${song.duration.toFixed(1)}s. Press Play.`;
  selectedKey = null;
  buildEditor();
  renderInstrumentEditor();
  drawRoll();
  updateSeek();
  saveLastSession();
}

// Remember the last-opened song so a refresh reopens it instead of the bundled
// demo. Only the song + name are stored; per-song voice/mixer config is keyed by
// song id and reloaded by openSong's loadConfig(). Local-only (localStorage).
const LAST_SESSION_KEY = "chiptune:lastSession";
function saveLastSession(): void {
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ song, songName }));
  } catch {}
}
function loadLastSession(): { song: Song; songName: string } | null {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { song?: Song; songName?: string };
    if (!s.song || !Array.isArray(s.song.notes) || typeof s.song.duration !== "number") return null;
    return { song: s.song, songName: s.songName || "restored song" };
  } catch {
    return null;
  }
}

function resetToDefaults(): void {
  try { localStorage.removeItem(cfgKey(songId)); } catch {}
  for (const k of Object.keys(voiceOverrides)) delete voiceOverrides[k];
  mixer.clear();
  for (const c of channelsOf(song)) mixer.set(c.key, newChannelMix(c));
  if (synth) synth.setMixer(mixer);
  applyOptions();
  buildEditor();
  renderInstrumentEditor();
  drawRoll();
  els.cfgStatus.textContent = "Reset to defaults";
}

// ---- wiring ----
els.play.addEventListener("click", togglePlay);
els.stop.addEventListener("click", stopPlayback);
/** Move the transport to `t` seconds (clamped), updating UI and restarting if playing. */
function seekTo(t: number): void {
  offset = Math.max(0, Math.min(t, song.duration));
  els.seek.value = String(offset);
  els.cur.textContent = fmtTime(offset);
  drawPlayhead(offset);
  if (running) {
    stopScheduled();
    startPlayback();
  }
}

els.seek.addEventListener("input", () => seekTo(Number(els.seek.value)));

// click (or drag) on the piano roll -> set the transport to that time
function rollSeek(ev: MouseEvent): void {
  if (song.duration <= 0) return;
  const rect = els.roll.getBoundingClientRect();
  const frac = (ev.clientX - rect.left) / rect.width; // canvas may be CSS-scaled
  seekTo(frac * song.duration);
}
els.roll.style.cursor = "pointer";
els.roll.addEventListener("mousedown", (ev) => {
  rollSeek(ev);
  const move = (e: MouseEvent) => rollSeek(e); // scrub while dragging
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

for (const ctl of [els.gm, els.drums, els.stereo, els.compress, els.reverb, els.delay, els.voice]) {
  ctl.addEventListener("change", () => {
    if (ctl === els.gm) els.voiceRow.style.display = els.gm.checked ? "none" : "flex";
    applyOptions();
  });
}
els.reverbMix.addEventListener("input", () => {
  els.reverbMixVal.textContent = Number(els.reverbMix.value).toFixed(2);
  applyOptions();
});
els.delayMix.addEventListener("input", () => {
  els.delayMixVal.textContent = Number(els.delayMix.value).toFixed(2);
  applyOptions();
});
els.resetCfg.addEventListener("click", resetToDefaults);
els.saveCfg.addEventListener("click", () => { saveConfig(); els.cfgStatus.textContent = `Saved “${songId}” ✓`; });

els.file.addEventListener("change", async () => {
  const f = els.file.files?.[0];
  if (!f) return;
  try {
    const ab = await f.arrayBuffer();
    const s = parseMidiBuffer(ab);
    stopPlayback();
    openSong(s, `${f.name} — ${s.notes.length} notes, ${s.duration.toFixed(1)}s @ ${s.tempoBpm} bpm`);
  } catch (e) {
    els.status.textContent = `Failed to parse MIDI: ${(e as Error).message}`;
  } finally {
    els.file.blur(); // move focus off the file input so the window spacebar handler plays it
  }
});

// ---- native project format (.chip): a versioned session superset of MIDI ----
const SESSION_FORMAT = "chiptune-session";
const SESSION_VERSION = 1;
interface Session {
  format: string;
  version: number;
  songName: string;
  song: Song;
  voiceOverrides: Record<string, VoiceOverride>;
  mixer: Record<string, ChannelMix>;
}

els.saveProject.addEventListener("click", () => {
  const session: Session = {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    songName,
    song,
    voiceOverrides,
    mixer: Object.fromEntries(mixer),
  };
  const blob = new Blob([JSON.stringify(session)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${songId || "session"}.chip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  els.cfgStatus.textContent = `Saved project ${a.download}`;
});

els.projectFile.addEventListener("change", async () => {
  const f = els.projectFile.files?.[0];
  if (!f) return;
  try {
    const session = JSON.parse(await f.text()) as Session;
    if (session.format !== SESSION_FORMAT || !session.song || !Array.isArray(session.song.notes)) {
      throw new Error("not a chiptune session file");
    }
    stopPlayback();
    openSong(session.song, session.songName || f.name, {
      voiceOverrides: session.voiceOverrides ?? {},
      mixer: session.mixer ?? {},
    });
    els.status.textContent = `Loaded project ${f.name} — ${song.notes.length} notes, ${song.duration.toFixed(1)}s`;
  } catch (e) {
    els.status.textContent = `Failed to load project: ${(e as Error).message}`;
  } finally {
    els.projectFile.value = "";
    els.projectFile.blur(); // let the window spacebar handler play instead of staying trapped on the input
  }
});

// ---- init ----
// debug hook (harmless): lets tooling measure a live block's RMS / inspect state
(window as unknown as { __chip: unknown }).__chip = {
  // RMS of a fresh render at time `atSec` using a throwaway synth (does not
  // disturb the live playhead), rendering `blocks` chunks of CHUNK samples.
  rms(atSec = 10, blocks = 24) {
    const probe = new StreamingSynth(song, buildOptions());
    probe.setMixer(mixer);
    probe.seek(Math.floor(atSec * ENGINE_SR));
    let s = 0, n = 0;
    for (let b = 0; b < blocks; b++) {
      const [L, R] = probe.renderBlock(CHUNK);
      for (let i = 0; i < L.length; i++) { s += L[i] * L[i] + R[i] * R[i]; n += 2; }
    }
    return Math.sqrt(s / n);
  },
  get mixer() { return mixer; },
  get overrides() { return voiceOverrides; },
  get ctxState() { return ctx ? ctx.state : "none"; },
  get ctxTime() { return ctx ? ctx.currentTime : 0; },
  get transport() { return currentTime(); },
  get running() { return running; },
  get scheduledCount() { return scheduled.size; },
  resumeCtx() { return ctx ? ctx.resume() : Promise.resolve(); },
};
els.voiceRow.style.display = els.gm.checked ? "none" : "flex";
els.reverbMixVal.textContent = Number(els.reverbMix.value).toFixed(2);
els.delayMixVal.textContent = Number(els.delayMix.value).toFixed(2);
buildPiano();
updateOctLabel();
initMidi();
const restored = loadLastSession();
if (restored) openSong(restored.song, restored.songName);
else openSong(bundledSong, songName);
requestAnimationFrame(frame);
