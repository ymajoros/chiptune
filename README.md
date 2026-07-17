# chiptune — a MIDI synthesiser and a singing voice, from scratch

No audio libraries, no DSP dependencies, no build step. A Standard MIDI File is
parsed by hand, rendered by five hand-written synthesis engines, and sung over
by a hand-written formant voice synthesiser — everything down to the WAV bytes.

Runs on Node's native TypeScript (22.6+): `node synth.ts`. That's it.

```
 .mid ──> midiParse.ts ──> Song{notes[]} ──┬──> synth.ts  ──> 5 engines + FX ──> chiptune.wav
          (or songData.ts, pre-parsed)     │
                                           └──> chorus.ts ──> backing (synth.ts)
                                                          +   sung lead (voice.ts) ──> chorus.wav
```

## The programs

| File | What it is |
|---|---|
| [`midiParse.ts`](midiParse.ts) | Standard-MIDI-File parser → flat `Note[]` (start, dur, pitch, velocity in seconds) |
| [`synth.ts`](synth.ts) | Music synthesiser: 5 engines, vibrato, sympathetic resonance, delay, reverb, mono/stereo |
| [`voice.ts`](voice.ts) | Klatt-style formant voice: **speaks** and **sings**, French phonemes |
| [`chorus.ts`](chorus.ts) | Both together: sings a song's melody over its own backing track |
| [`songData.ts`](songData.ts) | A song pre-parsed and embedded (base64 float32) so it runs with no `.mid` present |
| [`prototype/`](prototype/) | The original Python version, kept for reference |

Docs: **[synth](docs/synth.md)** · **[voice](docs/voice.md)** · **[findings](docs/findings.md)**

## Quick start

```bash
node synth.ts --play                                  # the bundled song, additive organ
node synth.ts --voice rhodes --stereo --reverb --play # FM electric piano, wide
node synth.ts --voice string --sympathetic --play     # plucked strings that ring together
node synth.ts some.mid --voice acid --delay --play    # any MIDI file

node voice.ts --say "bonjour tout le monde" --play    # speech (crude French G2P)
node voice.ts --phonemes "b O~ Z u R" --play          # exact phonemes
node voice.ts --sing "Z @ . v w a . l a . m E R" \
              --notes "66:0.6,67:0.6,69:0.4,71:1.6" \
              --transpose -12 --formants 0.88 --play  # singing, male

node chorus.ts --play                                 # sung chorus over the backing
```

Output is always a `.wav` in the working directory; `--play` pipes it to `aplay`
(Linux/ALSA — swap for `afplay`/`ffplay` elsewhere).

## What's actually in here

**Five synthesis engines** ([details](docs/synth.md)) — additive, 2-op FM,
subtractive (polyBLEP + resonant filter), formant/vocal, and Karplus–Strong
physical modelling. 13 named voices via `--voice`.

**Effects** — vibrato, delay, Schroeder reverb, stereo ping-pong, and
sympathetic string resonance (a bank of tuned resonators, in the song's own key,
excited by transients and coupled octave-to-fifth).

**A voice synthesiser** ([details](docs/voice.md)) — a real source-filter model:
Rosenberg glottal pulse → nasal pole/zero → 5-formant Klatt cascade → lip
radiation, with a parallel frication branch. Vowels, fricatives, nasals, stops
(closure/burst/VOT), liquids, a uvular French R, coarticulation, prosody,
melisma, and a male/female vocal-tract scale.

**[docs/findings.md](docs/findings.md)** is the most interesting file here: every
bug that mattered, what it sounded like, and what it actually was. Most of them
were *phonetics* errors wearing DSP clothing.

## Licence / contents

Code: do what you like with it.

`songData.ts` and the lyrics in `chorus.ts` are derived from a commercial
recording and are **not** ours to license. They're here as test data for a
personal experiment. Don't redistribute them.
