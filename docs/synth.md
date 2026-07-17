# synth.ts — the music synthesiser

Five engines, all summed by a trivial additive mixer into one buffer and written
straight to a 16-bit WAV. Pick a voice with `--voice <name>` (which selects its
engine automatically), or select an engine directly and turn its knobs.

Engine precedence when several are implied: **ks → formant → sub → fm → additive**.

## Engines

### 1. Additive (default)
Fundamental sine plus harmonic partials, phase-accumulated.

- `--sine` — pure sine, no harmonics
- `--harmonics "3:0.3,5:0.15"` — extra partials as `multiple:gain`

The default (`3:0.3,5:0.15`) sounds like an organ, and that's not a coincidence:
a Hammond drawbar organ *is* a handful of sines at harmonic ratios. Odd-only
harmonics read as hollow/reedy; a static mix with no decay reads as sustained.

### 2. FM (2-operator)
A carrier sine phase-modulated by a modulator sine:

```
out(t) = sin(wc·t + I(t)·sin(ratio·wc·t))
I(t)   = index · (sustain + (1−sustain)·e^(−t/decay))
```

`sustain` is the whole trick: **0** = the index decays to nothing, so the note
starts bright and mellows to a pure tone (a *struck* sound — Rhodes, bell);
**1** = the index holds, giving a steady spectrum (a *sustained* sound — organ).
`ratio` sets the character: integers → harmonic/tonal, non-integers → clangy.

- Voices: `rhodes`, `organ`, `brass`, `bell`
- Knobs: `--fm-ratio`, `--fm-index`, `--fm-decay`, `--fm-sustain`

### 3. Subtractive
Band-limited saw/square (polyBLEP anti-aliasing) → resonant low-pass whose
cutoff is swept by an envelope → optional unison detune. The filter sweep *is*
the sound; the amp envelope stays flat.

- Voices: `pluck`, `acid`, `strings`
- Knobs: `--wave saw|square`, `--cutoff`, `--res`, `--env`, `--env-decay`, `--detune`, `--unison`

The filter is a Chamberlin state-variable (cheap, modulatable per sample, stable
below SR/6 — hence the clamp).

### 4. Formant / vocal
A saw through three band-pass resonators parked at vowel formants. Same idea as
`voice.ts` but crude — this is the toy version that motivated the real one.

- Voices: `vox`, `choir`, `talk`
- Knobs: `--vowel a|e|i|o|u` (or a morph: `a>o`), `--choir N`, `--detune`

### 5. Karplus–Strong
A delay line one period long, filled with noise, then repeatedly low-passed and
fed back. The noise physically decays into a pitched tone, like a real string.
No oscillator, no spectrum specified — the sound emerges from the model.

- Voices: `string`, `harp`, `mute`
- Knobs: `--ks-decay` (sustain), `--ks-damping` (brightness)

## Effects

| Effect | Enable | Knobs (defaults) |
|---|---|---|
| Vibrato (pitch LFO) | `--vibrato` | `--vib-rate 5.5`, `--vib-depth 25` (cents) |
| Sympathetic resonance | `--sympathetic` | `--symp-feedback 0.9`, `--symp-damping 0.5`, `--symp-couple 0.03`, `--symp-mix 0.35` |
| Delay | `--delay` | `--delay-time 0.3`, `--delay-fb 0.35`, `--delay-mix 0.3` |
| Reverb (Schroeder) | `--reverb` | `--reverb-room 0.7`, `--reverb-mix 0.3` |
| Stereo | `--stereo` | ping-pong delay + decorrelated L/R reverb |

### Sympathetic resonance

A bank of tuned feedback combs — one "string" per pitch class **in the song**,
across two octaves. Untouched strings ring when the music hits their pitch, like
a piano with the pedal down.

Three things make it more than a pitched reverb:

- **Tuned in key.** The frequencies come from the song's own notes. A chromatic
  bank rings against every dissonance and turns to mush.
- **Excitation coupling.** The strings are driven by the signal's *transients*
  (an onset gate: fast envelope − slow envelope), not the sustained tone. A real
  string is set going by the attack, then rings on its own.
- **String coupling** (`--symp-couple`). Each string bleeds energy into its
  octave- and fifth-related neighbours, so striking one wakes its partners. A
  `tanh` in the loop models string saturation *and* keeps the coupled feedback
  network unconditionally stable.

Level is decoupled from character: the wet is scaled so its peak is
`mix × dry-peak`, so `feedback`/`couple` change the ring's *length*, never the
volume balance. (See findings — this took three attempts.)

### Master gain

One static, purely linear gain per render:

```
g = min(0.9/dryPeak, 0.99/fullMixPeak)
```

Aim the melody at 0.9; back off only if the finished mix would clip. No limiter,
no compressor, so nothing can distort or pump. The no-effects path is
bit-identical to plain peak normalisation.

## Envelope

Linear attack/release (`--attack ms`, `--release ms`, default 5/30). Short =
crisp/staccato, long = pad-like, zero = audible clicks on every note.

## Notes

- 44.1 kHz, mono unless `--stereo`. Always writes `chiptune.wav`.
- GM percussion (channel 9) is dropped — sine-on-drum-pitch is just noise.
- With no file argument it uses the bundled `songData.ts`.
