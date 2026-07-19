// Bundler for the chiptune web player. Compiles the TS engine + web glue to a
// browser bundle. NO runtime deps are added to the engine: the only Node bits
// (fs / child_process WAV+CLI, Buffer base64 decode, `process` in the CLI guard)
// are neutralised here at build time via stubs, never touching synth.ts.
//
//   node build.mjs            one-off dev build      -> web/app.js  (bundles songData.ts)
//   node build.mjs --serve    dev build, watch, serve at http://localhost:8080
//   node build.mjs --release  minified, self-contained release -> dist/
//
// The RELEASE build swaps the local (copyrighted) songData.ts for the ORIGINAL
// web/demoSong.ts, so the distributable never contains the copyrighted song.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const serve = process.argv.includes("--serve");
const release = process.argv.includes("--release");

// Stub Node built-ins the engine imports but the browser never calls.
const nodeStub = {
  name: "node-stub",
  setup(build) {
    build.onResolve({ filter: /^node:(fs|child_process|url|path)$/ }, () => ({
      path: "node-stub",
      namespace: "node-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: "export const readFileSync=()=>{throw new Error('fs unavailable in browser')};" +
        "export const writeFileSync=()=>{};export const spawnSync=()=>({});" +
        "export const fileURLToPath=()=>'';export const dirname=()=>'';export const resolve=()=>'';",
      loader: "js",
    }));
  },
};

// Release-only: redirect any import of songData.ts to the original demo song, so
// the copyrighted note data is never read, resolved, or bundled into dist/.
const swapSong = {
  name: "swap-song",
  setup(build) {
    build.onResolve({ filter: /(^|\/)songData\.ts$/ }, () => ({
      path: resolve(root, "web/demoSong.ts"),
    }));
  },
};

// Label shown for the pre-bundled song (injected via `define`, see app.ts).
const DEV_LABEL = "Chiptune demo (bundled)";
const RELEASE_LABEL = "Chiptune demo — original Am–F–C–G loop";

const base = {
  entryPoints: [resolve(root, "web/app.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "info",
  // Inject browser shims for the `Buffer` (songData base64) and `process` (CLI
  // guard) globals so the engine files run unmodified.
  inject: [resolve(root, "web/shims/buffer.js"), resolve(root, "web/shims/process.js")],
};

if (release) {
  // ---- self-contained release into dist/ -----------------------------------
  const dist = resolve(root, "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  await esbuild.build({
    ...base,
    outfile: resolve(dist, "app.js"),
    sourcemap: false,
    minify: true,
    define: { BUNDLED_SONG_LABEL: JSON.stringify(RELEASE_LABEL) },
    plugins: [nodeStub, swapSong], // swapSong => demoSong.ts, never songData.ts
  });

  // Static shell (already references ./app.js relatively) + license + readme.
  cpSync(resolve(root, "web/index.html"), resolve(dist, "index.html"));
  cpSync(resolve(root, "LICENSE"), resolve(dist, "LICENSE"));
  writeFileSync(resolve(dist, "README.txt"), distReadme());

  console.log("built release into dist/ (original demo song, minified, no sourcemap)");
  console.log("serve it with any static server, e.g.:  cd dist && python3 -m http.server 8080");
} else {
  // ---- dev build (uses the local songData.ts) ------------------------------
  const options = {
    ...base,
    outfile: resolve(root, "web/app.js"),
    sourcemap: true,
    define: { BUNDLED_SONG_LABEL: JSON.stringify(DEV_LABEL) },
    plugins: [nodeStub],
  };

  if (serve) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    const { host, port } = await ctx.serve({ servedir: resolve(root, "web"), port: 8080, host: "127.0.0.1" });
    console.log(`\nchiptune web player: http://${host}:${port}/\n(serving web/, rebuilding on change)`);
  } else {
    await esbuild.build(options);
    console.log("built web/app.js");
  }
}

// README shipped inside the distributable (kept here so it always matches the
// release build). Plain text on purpose — no tooling needed to read it.
// A hoisted function so the release block above can call it.
function distReadme() {
  return `chiptune — a from-scratch web MIDI player
==========================================

A tiny MIDI player and mixer that runs entirely in your browser. Every sound is
generated live by hand-written synthesis code — there are NO audio samples and
NO sound-fonts. A built-in synth engine (additive, FM, subtractive, Karplus–
Strong and formant voices) plus a procedural drum kit turn MIDI notes into audio
using the Web Audio API. Nothing is uploaded anywhere; it all runs locally.

RUN IT
------
It is a static site — open it through any web server (opening index.html
directly with file:// will not work because it loads app.js as a module).

  cd dist
  python3 -m http.server 8080      # then open http://localhost:8080/

  # or any equivalent:
  npx serve .                      # Node
  php -S localhost:8080            # PHP

WHAT YOU CAN DO
---------------
  * Press Play to hear the bundled original demo loop (Am–F–C–G).
  * "Import a .mid file" to play your own Standard MIDI File.
  * Mixer: per-channel volume / pan / mute / solo, and pick a GM instrument.
  * Effects: add reverb / delay / chorus and dial in per-track sends.
  * Instrument editor: tweak each channel's synth voice (engine, envelope,
    harmonics, filter, vibrato…).
  * Keyboard / audition: play with the mouse, the computer keys, or a real
    MIDI keyboard (Web MIDI, where supported).
  * Save / load your setup as a .chip project file.

The bundled demo is an original, public-domain (CC0) chord loop written just to
show the engine off — reuse it freely.

BUILD FROM SOURCE
-----------------
  node build.mjs            # dev build  -> web/app.js
  node build.mjs --serve    # dev build + watch + http://localhost:8080
  node build.mjs --release  # this self-contained bundle -> dist/

LICENCE
-------
Code is MIT licensed — see LICENSE.
`;
}
