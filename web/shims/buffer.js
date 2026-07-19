// Minimal browser Buffer shim — only what songData.ts needs: Buffer.from(b64,'base64').
// Returns a Uint8Array (which already exposes .buffer/.byteOffset/.byteLength/.length),
// so the DataView construction in songData.ts works unchanged.
export const Buffer = {
  from(input, encoding) {
    if (encoding === "base64") {
      const bin = atob(input);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // utf-8 / latin1 fallback (unused by the engine, here for completeness)
    const enc = new TextEncoder();
    return enc.encode(String(input));
  },
};
