# chiptune — web MIDI player

The from-scratch synth engine (`synth.ts`) running live in the browser via Web
Audio, with a real player UI on top. Same Float32 synthesis pipeline as the Node
CLI — no second engine, no runtime dependencies added.

## Run it

```sh
npm install        # dev-only: installs esbuild (the bundler). Nothing else.
npm run serve      # builds + watches + serves http://127.0.0.1:8080/
```

Open <http://127.0.0.1:8080/>. The bundled song (Chiptune demo) loads and
renders immediately; press **Play**.

One-off build without the server:

```sh
npm run build      # writes web/app.js (+ .map)
# then serve web/ with any static server, e.g.:
python3 -m http.server -d web 8080
```

The Node CLI is unchanged and still works:

```sh
node synth.ts --gm --drums --reverb --stereo   # writes chiptune.wav
```

## What the UI does

- **Default song** loads from `songData.ts` and plays **instantly** (no
  pre-render). Load any `.mid` with the file picker — parsed from its
  `ArrayBuffer` in the browser and streamed the same way.
- **Transport**: play / pause / stop / seek / current-time + duration, all driven
  by the streaming playhead (seek is instant).
- **Global controls** → `RenderOptions`: GM multi-instrument, drums, stereo,
  master compressor, the shared reverb (return level) and delay (mix) units, and
  (when GM is off) a global voice-preset picker.
- **Mixer** — per (track, channel): GM-instrument dropdown, patch **gain**, a
  **volume** fader (separate from the patch gain), **mute**, **solo**, and
  **reverb / delay sends** (0..1). Everything is applied live in the streaming
  mixer; mute/solo/volume affect even sustained notes within one buffer.
- **Instrument editor** — pick a channel’s **Edit** button to open a voice editor
  that adapts to the synthesis engine (additive harmonics list / FM ratio·index·
  decay·sustain / subtractive incl. **drive** distortion / Karplus–Strong /
  formant), plus the common attack·release·gain·foldAbove and an **engine
  switcher**. Edits write into that channel’s `VoiceOverride` and are heard live.
- **Keyboard / audition** — an on-screen piano (click, or computer keys A–K /
  W–U) plays the currently-edited voice through the same DSP; **Web MIDI**
  (`navigator.requestMIDIAccess`) drives it from a hardware keyboard when
  available (gracefully degrades to “not supported / permission denied”).
- **Save / Reset / auto-load** — the per-song config (all voiceOverrides + the
  full mixer state) is auto-saved to `localStorage` on every edit and on **Save**,
  keyed by a stable song hash, and **auto-loaded** when the same song reopens.
  **Reset to defaults** clears it.
- **Piano roll** (notes per channel, muted channels dimmed, live playhead).

## How it works (JIT streaming + buffering)

`web/streamingSynth.ts` (`StreamingSynth`) holds the Song + `RenderOptions` +
mixer + a pool of **stateful voices** and a sample playhead. `renderBlock(N)`:

1. spawns a voice for every note whose onset falls in this block (drums → a
   one-shot buffer voice; pitched → a `PitchedVoice` using the note’s resolved
   `Voice` from `gmVoiceFor(song, overrides)`);
2. advances every active voice, applying its attack at onset and release near its
   end, and **routes** each voice’s output into three mono buses — dry, a reverb
   **send** bus and a delay **send** bus — scaled by that channel’s live mixer
   gains (volume·mute·solo, reverbSend, delaySend);
3. runs the shared FX (streaming reverb with decorrelated L/R + ping-pong delay,
   both keeping ring-buffer state across blocks) as **send returns**, then the
   master chain: fixed makeup gain → `Compressor` (opt) → a limiter (a `Compressor`
   instance) → clamp. No whole-song peak-normalize (streaming can’t see the
   future).

The five engines reuse the **exact DSP math** of `renderTone` / `renderSub` /
`renderKs` / `renderFormant`, re-expressed statefully so phase / filter / delay-
line state carries across block boundaries. This was verified numerically during
development: for every engine, rendering a passage as one big block is
sample-identical to rendering it split into arbitrary small blocks.

**Buffering / scheduling** (`web/app.ts`): a main-thread scheduler renders
`CHUNK` (2048-sample, ~46 ms) blocks slightly **ahead** of the audio clock
(`SCHEDULE_AHEAD` ≈ 0.2 s) and queues each as a precisely-scheduled
`AudioBufferSourceNode` (`start(when)`), gaplessly. This absorbs CPU spikes,
gives instant start / seek, and lets instrument·mixer·FX edits be heard within
one buffer — the next block just reads the updated options/mixer. (An
AudioWorklet + SharedArrayBuffer producer would move synthesis off the main
thread but needs COOP/COEP headers; the main-thread scheduler is robust here and
hits all the same properties. Synthesis runs ~100× real-time, so a 46 ms block
costs well under a millisecond — the main thread has ample headroom.)

The offline `render()` / `renderStereo()` and the Node CLI are untouched and
still render WAVs offline.

## Platform boundary (why the engine didn't need forking)

The engine is pure Float32 sample generation — inherently portable. Only a few
Node-specific bits are neutralised **at build time**, so `synth.ts`, `gm.ts`,
`drums.ts`, `songData.ts` and `midiParse.ts` run unmodified in both places:

- `web/shims/buffer.js` — a `Buffer.from(b64, 'base64')` shim (uses `atob`) for
  `songData.ts`, injected as the `Buffer` global.
- `web/shims/process.js` — a `process` stub so `synth.ts`'s CLI guard
  (`import.meta.filename === process.argv[1]`) is simply false in the browser.
- `build.mjs`'s `node-stub` plugin — replaces `node:fs` / `node:child_process`
  (WAV write + `aplay`, browser-unreachable) with throwing/no-op stubs.
- `midiParse.ts` gained one small, CLI-safe seam: `parseMidiData(data)` holds the
  parser and `parseMidi(path)` is now just its file wrapper. `web/browserMidi.ts`
  feeds it an `ArrayBuffer` wrapped in a tiny `Uint8Array` subclass exposing the
  three `Buffer` methods the parser uses (`readUInt16BE`, `readUInt32BE`,
  `toString`).

## Files

```
build.mjs             dev-only esbuild build/serve script
web/index.html        the player UI
web/app.ts            transport, scheduler, mixer/instrument editor, piano, MIDI, persistence
web/streamingSynth.ts JIT block synthesis: stateful voices, send-bus mixer, streaming FX
web/browserMidi.ts    ArrayBuffer -> Song (browser MIDI parse)
web/shims/*.js        browser Buffer / process globals + node stubs
```

Persisted config is `localStorage["chiptune:cfg:<songHash>"]` =
`{ voiceOverrides, mixer }`. Delete it (or hit **Reset to defaults**) to start
fresh.

`node_modules/`, `web/app.js` and `web/app.js.map` are git-ignored — run
`npm install && npm run build` to regenerate.
