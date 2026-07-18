/**
 * drums.ts — synthesize a General MIDI drum hit (channel 10 / index 9).
 *
 * Percussion isn't pitched playback, it's a transient shaped by physics, so each
 * type has its own recipe rather than an engine + note:
 *   kick  = a sine whose pitch drops fast (the "thump"), quick amp decay
 *   snare = noise (the wires) + a couple of body tones, medium decay
 *   hats  = short high-passed noise (closed) or longer (open)
 *   toms  = pitched sine thump, tuned by the drum
 *   cymbals = dense bright noise, long decay
 * The GM drum map keys these off the note number (36 kick, 38 snare, 42 hat…).
 */

const SR = 44100;

const rnd = () => Math.random() * 2 - 1;

/** One-pole high-pass (for hats/cymbals): y = x - lp, lp += a*(x-lp). */
function makeHP(a: number) {
  let lp = 0;
  return (x: number) => {
    lp += a * (x - lp);
    return x - lp;
  };
}

/** Sine with an exponential pitch drop from f0 to f1, and exponential amp decay. */
function thump(n: number, f0: number, f1: number, pitchTau: number, ampTau: number, click = 0): Float32Array {
  const out = new Float32Array(n);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    const t = k / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t / pitchTau);
    ph += (2 * Math.PI * f) / SR;
    let s = Math.sin(ph) * Math.exp(-t / ampTau);
    if (click && k < 60) s += click * rnd() * (1 - k / 60); // attack transient
    out[k] = s;
  }
  return out;
}

/** Decaying filtered noise (snare wires, air). */
function noiseBurst(n: number, ampTau: number, hpA: number): Float32Array {
  const out = new Float32Array(n);
  const hp = makeHP(hpA);
  for (let k = 0; k < n; k++) out[k] = hp(rnd()) * Math.exp(-(k / SR) / ampTau);
  return out;
}

/** Stateful RBJ band-pass (for the snare's "crack" / tuned noise). */
function makeBP(fc: number, q: number) {
  const w0 = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0,
    b2 = -alpha / a0,
    a1 = (-2 * Math.cos(w0)) / a0,
    a2 = (1 - alpha) / a0;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  return (x: number) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

// Six inharmonic ratios — the classic analog-drum trick for a METALLIC timbre.
// Filtered noise alone reads as "shh"; summing detuned square partials makes the
// clangy "tss" of a real hi-hat / cymbal (their vibration modes are inharmonic).
const METAL = [2, 3, 4.16, 5.43, 6.79, 8.21];

/**
 * Metallic percussion (hats, cymbals, ride): six square oscillators at
 * inharmonic ratios of `f0`, high-passed, blended with a little noise, decaying.
 */
function metallic(n: number, f0: number, ampTau: number, hpA: number, noiseMix: number): Float32Array {
  const out = new Float32Array(n);
  const hp = makeHP(hpA);
  const ph = new Float64Array(6);
  const inc = METAL.map((r) => (f0 * r) / SR);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let o = 0; o < 6; o++) {
      s += ph[o] < 0.5 ? 1 : -1;
      ph[o] += inc[o];
      if (ph[o] >= 1) ph[o] -= 1;
    }
    s /= 6;
    s = (1 - noiseMix) * s + noiseMix * rnd();
    out[k] = hp(s) * Math.exp(-(k / SR) / ampTau);
  }
  return out;
}

// A crash needs a much DENSER inharmonic field than a hi-hat — a real cymbal
// rings in dozens of closely-spaced modes at once, which is what gives the
// shimmering "crash" instead of a "shhh". Sixteen irregular ratios spanning a
// wide range; each square partial also adds its own overtones, thickening it.
const CRASH_MODES = [1, 1.41, 1.83, 2.24, 2.68, 3.14, 3.63, 4.18, 4.79, 5.47, 6.22, 7.05, 7.97, 9.02, 10.2, 11.6];

/**
 * Crash / splash cymbal: a dense inharmonic bloom, mostly tonal metal (low
 * noise), with a fast bright "strike" layered over a slower shimmering tail so
 * it swells and rings rather than reading as a flat noise wash.
 */
function crashCymbal(n: number, f0: number, ampTau: number, noiseMix: number): Float32Array {
  const out = new Float32Array(n);
  const hp = makeHP(0.45);
  const ph = new Float64Array(CRASH_MODES.length);
  const inc = CRASH_MODES.map((r) => (f0 * r) / SR);
  const bloomN = 0.004 * SR; // 4ms swell-in so the attack isn't an instant blast
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let o = 0; o < CRASH_MODES.length; o++) {
      s += ph[o] < 0.5 ? 1 : -1;
      ph[o] += inc[o];
      if (ph[o] >= 1) ph[o] -= 1;
    }
    s /= CRASH_MODES.length;
    s = (1 - noiseMix) * s + noiseMix * rnd();
    const t = k / SR;
    const bloom = k < bloomN ? k / bloomN : 1;
    // two-rate decay: a bright fast strike over a long shimmer tail
    const env = 0.55 * Math.exp(-t / ampTau) + 0.45 * Math.exp(-t / (ampTau * 0.3));
    out[k] = hp(s) * bloom * env;
  }
  return out;
}

const secs = (s: number) => Math.max(1, Math.floor(s * SR));

/**
 * Render a GM drum note. Returns the hit (its own length/decay — the MIDI note
 * duration is ignored, as a drum rings for as long as it physically rings).
 */
export function renderDrum(note: number, velocity: number): Float32Array {
  const amp = (velocity / 127) ** 1.2;
  let buf: Float32Array;
  let gain = 1;

  switch (note) {
    case 35: // Acoustic Bass Drum
    case 36: {
      // Bass Drum: a sub "thump" (pitch-dropping sine) LAYERED with a short
      // band-passed "beater click" ~2.8kHz — the click is what makes a kick read
      // as a real drum being struck rather than a synth boom.
      const n = secs(0.13);
      const sub = thump(n, 155, 62, 0.022, 0.08, 0);
      const bp = makeBP(2800, 0.8);
      buf = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const click = k < secs(0.012) ? bp(rnd()) * Math.exp(-(k / SR) / 0.004) : 0;
        buf[k] = sub[k] + 0.5 * click;
      }
      gain = 0.6;
      break;
    }
    case 37: // Side Stick
      buf = thump(secs(0.06), 1800, 1200, 0.004, 0.03, 1.2);
      gain = 0.7;
      break;
    case 38: // Acoustic Snare
    case 40: {
      // Snare = a tuned head "thock" + a wire buzz. Real snares are SHORT and
      // snappy, not a long wash: keep the noise tail brief (fast decay), narrow
      // the wire band so it cracks rather than hisses, and add a sharp stick
      // transient at the very start so it reads as a hit.
      const n = secs(0.13);
      const body = thump(n, 340, 190, 0.03, 0.055, 0);
      const bp = makeBP(2400, 1.4);
      const hp = makeHP(0.4);
      const snapN = secs(0.006);
      buf = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const t = k / SR;
        const wire = bp(rnd()) * Math.exp(-t / 0.036); // fast-decaying buzz
        const snap = k < snapN ? hp(rnd()) * (1 - k / snapN) : 0; // stick attack
        buf[k] = 0.5 * body[k] + 0.75 * wire + 0.45 * snap;
      }
      gain = 1.0;
      break;
    }
    case 39: {
      // Hand Clap: a few quick noise bursts
      const n = secs(0.18);
      buf = new Float32Array(n);
      const hp = makeHP(0.4);
      for (let k = 0; k < n; k++) {
        const t = k / SR;
        const burst = t < 0.02 || (t > 0.01 && t < 0.03) || (t > 0.02 && t < 0.045);
        buf[k] = hp(rnd()) * Math.exp(-t / 0.05) * (burst ? 1 : 0.5);
      }
      gain = 0.9;
      break;
    }
    case 42: // Closed Hi-Hat — metallic, tight decay
    case 44: // Pedal Hi-Hat
      buf = metallic(secs(0.05), 1150, 0.028, 0.55, 0.35);
      gain = 0.4;
      break;
    case 46: // Open Hi-Hat — metallic, long decay
      buf = metallic(secs(0.35), 1150, 0.14, 0.55, 0.35);
      gain = 0.42;
      break;
    case 49: // Crash 1 — dense metallic bloom
    case 57: // Crash 2
      buf = crashCymbal(secs(1.4), 480, 0.7, 0.12);
      gain = 0.85;
      break;
    case 52: // Chinese — trashier: brighter, more noise, shorter
      buf = crashCymbal(secs(0.9), 620, 0.5, 0.22);
      gain = 0.8;
      break;
    case 55: // Splash — small, quick
      buf = crashCymbal(secs(0.5), 760, 0.3, 0.14);
      gain = 0.75;
      break;
    case 51: // Ride — metallic ping (bell + shimmer)
    case 53: // Ride Bell
    case 59: {
      const n = secs(0.5);
      const bell = thump(n, 2400, 2400, 1, 0.35, 0); // the "ping"
      const shimmer = metallic(n, 1400, 0.3, 0.5, 0.4);
      buf = new Float32Array(n);
      for (let k = 0; k < n; k++) buf[k] = 0.3 * bell[k] + 0.55 * shimmer[k];
      gain = 0.42;
      break;
    }
    case 54: // Tambourine
      buf = noiseBurst(secs(0.15), 0.06, 0.85);
      gain = 0.5;
      break;
    case 56: {
      // Cowbell: two square-ish tones
      const n = secs(0.25);
      buf = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const t = k / SR;
        const s = Math.sign(Math.sin(2 * Math.PI * 540 * t)) + Math.sign(Math.sin(2 * Math.PI * 800 * t));
        buf[k] = 0.3 * s * Math.exp(-t / 0.1);
      }
      gain = 0.55;
      break;
    }
    default: {
      // Toms (41-50) and everything else: a pitched thump tuned by note number.
      if (note >= 41 && note <= 50) {
        const f = 90 * 2 ** ((note - 43) / 12); // higher note number -> higher tom
        buf = thump(secs(0.3), f * 1.8, f, 0.04, 0.18, 0.2);
        gain = 1.0;
      } else {
        // unknown percussion: a short bright click
        buf = noiseBurst(secs(0.08), 0.04, 0.6);
        gain = 0.5;
      }
    }
  }

  const g = amp * gain * 0.6;
  for (let k = 0; k < buf.length; k++) buf[k] *= g;
  return buf;
}
