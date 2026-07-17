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

- **Default song** loads from `songData.ts` and plays with no file needed.
- **Load a `.mid`** with the file picker — parsed from its `ArrayBuffer` in the
  browser, then rendered and played.
- **Transport**: play / pause / stop / seek / current-time + duration.
- **Controls** map to `RenderOptions`: GM multi-instrument on/off, drums on/off,
  stereo on/off, reverb on/off + mix, and (when GM is off) a global voice-preset
  picker (FM / subtractive / Karplus-Strong / formant / additive).
- **Piano roll** visualization (notes coloured per channel, live playhead) and a
  **track / GM-instrument** table.

## How it works (offline-render then play)

On load and on every control change, the app calls the engine's
`render()` / `renderStereo()` — the exact functions the CLI uses — to produce a
stereo `AudioBuffer`, and plays it through an `AudioBufferSourceNode`. A ~196 s
song renders in ~2 s, ~295 s in ~4 s (measured in-browser). The transport
position is preserved across re-renders. This is a straightforward, robust MIDI
player; a streaming AudioWorklet was left as a possible future step.

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
build.mjs            dev-only esbuild build/serve script
web/index.html       the player UI
web/app.ts           transport, controls, piano roll, re-render logic
web/browserMidi.ts   ArrayBuffer -> Song (browser MIDI parse)
web/shims/*.js       browser Buffer / process globals + node stubs
```

`node_modules/`, `web/app.js` and `web/app.js.map` are git-ignored — run
`npm install && npm run build` to regenerate.
