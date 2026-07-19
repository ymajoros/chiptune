// Browser stub for Node's `process`. The synth.ts CLI block is guarded by
//   if (import.meta.filename === process.argv[1]) { ... }
// In the browser import.meta.filename is undefined; argv[1] here is a sentinel
// string, so the guard is false and the CLI never runs. The other fields keep
// any incidental references from throwing.
export const process = {
  argv: ["node", "__chiptune_web__"],
  env: {},
  platform: "browser",
  exit() {},
};
