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

/** Decaying filtered noise (hats, cymbals, snare wires). */
function noiseBurst(n: number, ampTau: number, hpA: number): Float32Array {
  const out = new Float32Array(n);
  const hp = makeHP(hpA);
  for (let k = 0; k < n; k++) out[k] = hp(rnd()) * Math.exp(-(k / SR) / ampTau);
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
    case 36: // Bass Drum 1
      buf = thump(secs(0.22), 130, 48, 0.03, 0.14, 0.5);
      gain = 1.25;
      break;
    case 37: // Side Stick
      buf = thump(secs(0.06), 1800, 1200, 0.004, 0.03, 1.2);
      gain = 0.7;
      break;
    case 38: // Acoustic Snare
    case 40: {
      // Electric Snare: body tones + noise wires
      const n = secs(0.2);
      const body = thump(n, 330, 180, 0.05, 0.12, 0);
      const wires = noiseBurst(n, 0.13, 0.5);
      buf = new Float32Array(n);
      for (let k = 0; k < n; k++) buf[k] = 0.5 * body[k] + 0.7 * wires[k];
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
    case 42: // Closed Hi-Hat
    case 44: // Pedal Hi-Hat
      buf = noiseBurst(secs(0.05), 0.03, 0.75);
      gain = 0.55;
      break;
    case 46: // Open Hi-Hat
      buf = noiseBurst(secs(0.3), 0.12, 0.7);
      gain = 0.5;
      break;
    case 49: // Crash 1
    case 52: // Chinese
    case 55: // Splash
    case 57: // Crash 2
      buf = noiseBurst(secs(1.2), 0.5, 0.55);
      gain = 0.6;
      break;
    case 51: // Ride 1
    case 53: // Ride Bell
    case 59: {
      // Ride 2: brighter noise + a bell tone
      const n = secs(0.5);
      const bell = thump(n, 2400, 2400, 1, 0.3, 0);
      const wash = noiseBurst(n, 0.35, 0.6);
      buf = new Float32Array(n);
      for (let k = 0; k < n; k++) buf[k] = 0.25 * bell[k] + 0.5 * wash[k];
      gain = 0.5;
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
