# voice.ts — the voice synthesiser

A Klatt-style formant synthesiser that speaks and sings. It is a **source-filter
model**, which is how a voice actually works:

```
glottal pulse ──> nasal pole/zero ──> formant cascade ──> lip radiation ──┐
                                          (F1..F5)                        ├──> out
white noise ──> frication pole bank (parallel) ──────────────────────────┘
```

- **Source** — a *Rosenberg glottal pulse* at F0. The folds open smoothly, snap
  shut, then stay closed; that asymmetry and the sharp closure are where the
  voice's harmonic richness comes from. A saw or square sounds like a synth.
- **Nasal pole/zero** — see below.
- **Filter** — a cascade of 2-pole Klatt resonators. The vocal tract is a
  resonant tube; moving the formants *is* moving your tongue and lips. F1 tracks
  mouth openness, F2 tracks tongue front/back.
- **Radiation** — a differentiator (+6 dB/oct), sound leaving the lips. Applied
  to the **voiced branch only**.

## The two noise branches

This distinction matters more than anything else in the file:

| | Where the noise is made | Route |
|---|---|---|
| **Aspiration** `/h/` | at the glottis | **cascade** — the whole tract is in front of it |
| **Frication** `/s/ /S/ /f/…` | at a front constriction | **parallel** — the tract is *behind* it |
| **French R** `/ʁ/` | at the uvula (very back) | **cascade** — like /h/ |

Get this wrong and it's audible immediately. Frication through the cascade gets
blasted ~4× above the vowels (each resonator has enormous gain at its peak).
The uvular R through the parallel branch gets *no* formant shaping at all —
unshaped noise bands instead of a throat.

Frication also needs a **true band-pass** (RBJ, zeros at DC and Nyquist), not
`reson()` — the Klatt resonator is all-pole with unity gain at **DC**, so it
passes low frequencies straight through. And a single 2-pole section rolls off
only 6 dB/oct, which leaves a broadband tail under the peak that you hear as
whispering; each pole is therefore **two cascaded sections** (12 dB/oct).

## Nasals — a pole-zero pair

Closing the lips/tongue leaves the oral cavity as a dead-end side branch that
*traps* energy, notching the spectrum. The notch frequency encodes the place of
articulation — that's how you hear /m/ vs /n/.

Klatt's trick: the nasal **pole** (~270 Hz, the murmur) and the **zero** are both
permanently in the cascade, and for a non-nasal sound the zero is parked exactly
on the pole with the same bandwidth so they **cancel algebraically**. Nasality is
then just "how far the zero moves off the pole" — continuous, and it glides for
free.

```
zEff = NASAL_POLE + (zeroF − NASAL_POLE) · nas
```

**Zero placement is critical, and differs by category:**

- Nasal **consonants**: F1 is only ~250, so their place-dependent zero
  (/m/ 750, /n/ 1600, /ŋ/ 3000) correctly sits *above* it.
- Nasal **vowels**: the zero must sit *between* the pole and that vowel's **own
  F1** (A~ 450 with F1 700; E~ 400 with F1 550; O~ 340 with F1 450). It is a
  perturbation of the low end, not a hole in the vowel. Put it on F1 and you
  cancel the formant that defines the vowel.

## Consonants

- **Fricatives** — a multi-pole spectrum, not one resonance. `/s/` 5800+7400,
  `/S/` 2400+3400+4800, `/f/` two weak high poles. `/f/` is the weakest sound in
  speech (~−23 dB vs a vowel) and its identity *is* being diffuse and quiet.
- **Voiced fricatives** — noise is **pulsed by the glottal cycle**
  (`0.3 + 0.7·glottal_flow`): airflow surges as the folds open. Steady buzz +
  steady hiss reads as two unrelated sounds; pulsing fuses them into one.
- **Stops** — `closure → 8 ms burst → VOT aspiration`. The burst must be short:
  stretch it to ~27 ms and it stops being a stop and becomes an affricate
  ("tss"). The VOT gap after release *is* the /t/–/d/ distinction. Aspiration
  runs through the cascade, so the formants gliding toward the next vowel colour
  it, as a real release does.
- **Loci** — place is signalled by where F2/F3 *point* on release. Labials → low
  F2 (~800), alveolars → ~1750, velars → F2/F3 "pinched" (1950/2250).
- **French R** — uvular /ʁ/, **not** the English /ɹ/, whose entire identity is a
  dropped F3 (~1600). French R keeps F3 **high** (2400), has a low F2, real
  frication through the cascade, and a light ~28 Hz uvular flutter.

## Coarticulation

Formants glide between phoneme targets over a **bounded ~55 ms window** centred
on each boundary, clamped to the shorter neighbour.

Bounded is the important word. Interpolating centre-to-centre makes the glide as
long as the segments: after a held vowel the tract crawls to the next target for
~250 ms, passing through mid-central space — which *is* a schwa. Real
articulators move in ~50 ms whatever the vowel's length.

**Silence is not an articulatory target.** The mouth is already placed before you
speak; gliding to/from the `_` segment's nominal formants drags every short
vowel through schwa. (Stop closures *do* glide — their formants carry the locus.)

## Prosody

- **Speech**: a declining F0 contour with jitter. Flat pitch is the robot
  giveaway. `--question` (or a trailing `?`) gives a rising terminal — a French
  yes/no question needs it or it reads as a statement.
- **Singing**: **portamento**. The larynx has mass; it cannot teleport between
  notes. Snapping F0 at each boundary is exactly what pitch-quantisation does and
  sounds like exaggerated autotune. The glide is geometric (log-domain — pitch is
  logarithmic, so that's the musically straight line), smoothstep-eased, and
  scaled by interval: big leaps take longer to travel. Vibrato fades in.

## Voice type

`--formants <scale>` scales **every** formant and nasal zero. A man's vocal tract
is ~17 cm vs ~15 cm, so *all* his formants sit ~10% lower (`0.88` ≈ male, `1.0`
neutral, `>1` female). **Pitch alone does not make a voice male** — drop F0
without moving the formants and you get a child, or a chipmunk in reverse.

## Lyrics format

- Space-separated phoneme tokens: `b O~ Z u R`
- `_` — pause
- `.` — **explicit syllable boundary**. Without it, every consonant becomes the
  onset of the following vowel and a **coda is impossible**: `p a R s a` gives
  /pa.ʁsa/ when *par sa* is /paʁ.sa/; `R o z l a` gives /ʁo.zla/ instead of
  /ʁoz.la/.
- `-` — **melisma**: hold this syllable across one more note. Required, not a
  luxury: real lyrics never line up one-syllable-per-note.

Vowels `a e E i o O u y 2 @`, nasal vowels `A~ O~ E~`, nasals `m n N`, liquids
`l R w j`, fricatives `s z S Z f v h`, stops `p b t d k g`, silence `_`.

## CLI

```
--say "text"        crude French letter-to-sound (see caveat)
--phonemes "..."    exact control
--sing "..." --notes "midi:dur,..."   [--transpose n]
--f0 110            speech pitch (ignored when singing — the notes set it)
--formants 0.88     vocal tract scale
--rate 1            speech rate
--question          rising terminal
--out file.wav  --play
```

`--say` uses a deliberately crude French ruleset (nasals, digraphs, silent
finals). It gets "bonjour tout le monde" → `/b O~ Z u R _ t u _ l @ _ m O~ d @/`,
but it can't split hyphens (`est-ce`) and fires `x→ks` on silent finals (`veux`).
Real G2P needs a pronunciation dictionary; use `--phonemes` when it matters.
