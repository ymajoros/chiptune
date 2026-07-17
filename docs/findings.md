# Findings

Every bug that mattered, what it sounded like, and what it actually was. Written
down because the pattern is worth keeping: **almost none of these were DSP bugs.**
The filters were fine. What was wrong was phonetics, physics, or one wrong
constant sitting in a table that looked entirely reasonable.

The synth was built and debugged by ear — a human listening and reporting, e.g.
"it sounds like par-**eu**-sa", "too explosive", "like an exaggerated
autotune". Every entry below started as one of those sentences.

---

## The ones where the diagnosis was in the complaint

### "par-**eu**-sa" — a schwa that was never written

Two causes, both real:

1. **Coarticulation was centre-to-centre**, so transition time scaled with
   segment length. After a 460 ms held /ɛ/ the tract took **~265 ms** to reach
   the /ʁ/ target, creeping through mid-central vowel space — which *is* a
   schwa. Fixed: a bounded ~55 ms transition window centred on each boundary.
   Real articulators move in ~50 ms whatever the vowel's length.
2. **The R was in the wrong syllable.** The syllabifier made every consonant the
   onset of the following vowel, so `p a R s a` → /pa.**ʁ**sa/ — the R leading
   *into* "ça". It could not express a coda. Fixed with explicit `.` boundaries:
   /paʁ.sa/.

### "a **uh uh uh**" — silence was a formant target

The `_` phoneme carried schwa formants (500/1500). Every vowel glided 27.5 ms
*from* that schwa and 27.5 ms back *to* it — so most of a 120 ms vowel was a
schwa glide.

The tell was in the report: the **first** /a/ sounded right. It's the only vowel
with no preceding segment, hence no glide-in. Silence has no tongue position —
you don't coarticulate with it. (Stop closures still glide: their formants carry
the place-of-articulation cue.)

### "ah hein **on** pfff" — notching out the formant that defines the vowel

*hein* /ɛ̃/ and *on* /ɔ̃/ are both nasal, so nasality **was** working — /ɑ̃/ was
just coming out as the wrong nasal vowel. Measured peaks showed the 240 Hz nasal
pole **15 dB above F1**: you heard the murmur, not the vowel, so A~ and O~
collapsed together.

The cause wasn't the pole's strength (widening its bandwidth didn't help — it
just widened the notch). **A~'s zero sat at 616 Hz, on top of its F1 at 700 Hz.**
For a nasal *vowel* the zero belongs *between* the pole and that vowel's own F1.
The same 750 Hz zero is correct for /m/ only because /m/'s F1 is 250. I'd applied
consonant logic to vowels.

| | nasal pole | F1 |
|---|---|---|
| /a/ (oral) | −13 dB | 0 dB |
| /A~/ before | 0 dB | **−15 dB** |
| /A~/ after | 0 dB | **−4 dB** |

### "too explosive / noise" (/f/) — a filter that wasn't filtering

Three faults. Too loud (−14 dB vs the vowel; /f/ is the weakest sound in speech,
−20…−26). Too long (90 ms → 60). And the real one: the poles were
`[1500, bw 2300]` — **Q = 0.65**. That is a straight wire, not a filter. /f/ was
white noise with a level. I'd written those wide bandwidths *deliberately*,
reasoning "/f/ is diffuse" — but diffuse doesn't mean unfiltered, and I never
measured whether they filtered anything.

### "like an exaggerated autotune" — the larynx has mass

`singF0` snapped `cur.hz` at every note boundary: an instantaneous pitch jump,
which is literally what pitch-quantisation does. Fixed with portamento —
geometric (log-domain) interpolation, smoothstep, duration scaled by interval.

Same class of error as the coarticulation bug: **the targets were modelled, the
travel between them wasn't.**

### "still not French enough" (R) — an English R with a French accent

`f: [400, 1300, 2200]` — that **F3 dropped to 2200** is the entire identity of
the English alveolar /ɹ/. French /ʁ/ is uvular: F3 stays **high** (2400), F2 is
low, and it's genuinely fricated.

And structurally: its frication was on the **parallel** branch. But /ʁ/ is made
at the *uvula* — nearly the whole oral cavity is in *front* of the noise source,
so the tract must filter it (cascade, like /h/). On the parallel branch it got no
formant shaping at all: unshaped noise bands, not a throat. I'd applied /s/ logic
(front constriction → bypass the tract) to a back consonant.

### "sounds like whispering alongside" — filter skirts

Fricatives were single 2-pole band-passes: **6 dB/oct**. White noise has energy
at every frequency, so a slope that gentle leaks a broadband tail under the peak.
Measured in dB, /s/ was only **−21 dB** at 1500–2500 Hz where a real /s/ is ~40
down. Fixed by cascading two sections per pole (12 dB/oct): −21 → **−37 dB**.

Note the metric error: an earlier check reported "0% energy below 2 kHz" and I
believed it. **Percentages are dominated by the peak and hide anything 20–30 dB
down.** Switching to dB-relative-to-peak made it obvious instantly.

---

## The one that was just wrong

### "unintelligible noise" — I deleted the vocal tract

A patch replaced everything between two comment markers, and the **5-resonator
formant cascade lived inside that range**. For several renders there were no
formants at all: a glottal buzz through a nasal filter.

What found it: **controls**. Re-playing an older, byte-identical render proved the
audio chain was fine, so the regression had to be mine. My own measurement had
already flagged it — one spectral peak where speech has a dozen — and I explained
it away, while theorising about whether nasality is perceptible at sung pitch.

It also **invalidated two rounds of feedback**: "barely audible" and "can't hear
it at all" were reports on a synth with no vocal tract. They said nothing about
the nasal model.

---

## Level and gain

### Sympathetic resonance: three attempts

1. **"volume is way down"** — with `feedback 0.95` the resonators accumulated
   energy across the whole song and peaked near the *end* (289 s). Peak
   normalisation keyed off that tail and scaled the entire track down.
2. **Fix attempt: gain off the dry signal** → a **saturated wall** (rms 32448 of
   32767). At those settings the wet is intrinsically far louder than the dry, so
   the limiter just flattened everything.
3. **Actual fix:** compute the wet separately and scale it so its peak is
   `mix × dry-peak`. Now `feedback`/`couple` change the ring's *character*, never
   the *volume balance*.

### "it sometimes distorts, softens"

The master soft-clipper. With the melody gained to 0.9 peak, every loud moment
crossed the threshold and got compressed — a nonlinear limiter both distorts and
ducks. Replaced with **one static linear gain**:
`g = min(0.9/dryPeak, 0.99/fullMixPeak)`. Purely multiplicative, so it *cannot*
distort or pump. Verified: 0 clipped samples.

### Fricatives 4× louder than vowels

Frication was routed through the formant cascade, where each resonator has
enormous gain at its peak. Real Klatt synths use a separate parallel branch
precisely for this. Also added per-phoneme voicing levels: a constriction chokes
glottal flow (voiced fricatives 0.5), nasals lose energy into the nasal cavity
(0.7). Vowels are the loudest thing we say.

---

## Data format

`songData.ts` embeds the parsed song. Three formats, in order:

| Form | Size | Exact? |
|---|---|---|
| decimal tuples | 115 KB | yes |
| float64 base64 | 66.6 KB | yes (bit-identical render) |
| **float32 base64** | **40.4 KB** | no — 484/2490 notes shift by **≤1 sample (0.023 ms)** |

float32 was chosen deliberately: 0.023 ms is ~2000× shorter than the 5 ms attack
ramp, so it's inaudible. Worth noting *why* float64 was needed for exactness —
rounding to microseconds shifted a handful of notes across a sample boundary, and
JS prints the shortest round-trippable decimal, so **not rounding at all** is what
round-trips.

---

## Lessons

- **Measure the right thing.** "0% below 2 kHz" (percent) vs "−21 dB at 1.5 kHz"
  (dB) — same signal, opposite conclusions.
- **Measure before theorising.** Two of the analysis passes above were themselves
  buggy: one found harmonics instead of formants (needed smoothing wider than
  F0), another reported /m/'s zero at 2880 Hz when it was at 730 (a global
  minimum in the −35 dB shelf above F3). Both nearly sent me the wrong way.
- **Keep a control.** An old, byte-identical render is the cheapest way to answer
  "did I break it, or is it the environment?"
- **A plausible table can be nonsense.** `bw: 2300` on a 1500 Hz pole reads fine
  and filters nothing. `f: [400, 1300, 2200]` reads fine and is a different
  language's R.
- **Model the travel, not just the targets.** Formant transitions and pitch
  glides were both missing for the same reason.
- **The human ear was the ground truth, every time.** Every entry here started as
  a sentence like "it sounds a bit clicky" — and each one turned out to have a
  specific, findable cause.
