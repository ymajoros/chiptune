// Dev-only bundler for the chiptune web player. Compiles the TS engine + web glue
// to a browser bundle. NO runtime deps are added to the engine: the only Node
// bits (fs / child_process WAV+CLI, Buffer base64 decode, `process` in the CLI
// guard) are neutralised here at build time via stubs, never touching synth.ts.
//
//   node build.mjs            one-off build
//   node build.mjs --serve    build, watch, and serve at http://localhost:8080
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const serve = process.argv.includes("--serve");

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

const options = {
  entryPoints: [resolve(root, "web/app.ts")],
  bundle: true,
  format: "esm",
  outfile: resolve(root, "web/app.js"),
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  // Inject browser shims for the `Buffer` (songData base64) and `process` (CLI
  // guard) globals so the engine files run unmodified.
  inject: [resolve(root, "web/shims/buffer.js"), resolve(root, "web/shims/process.js")],
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
