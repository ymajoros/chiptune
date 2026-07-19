/**
 * lyrics.ts — phonemised, note-aligned singing material.
 *
 * Format (see docs/voice.md):
 *   "."  explicit syllable boundary (lets a consonant be a CODA)
 *   "-"  melisma: hold this syllable across one more note
 *
 * `first`/`last` index the melody line (track 3 / channel 0) of songData.ts.
 * The syllable count + melismas must total exactly (last - first) notes;
 * voice.ts errors loudly with the arithmetic if they don't.
 *
 * All lyrics here (verse AND chorus) are original text written as a phonetic
 * test bench, not any recording's words. They are deliberately loaded with the
 * things that have been hard: nasal vowels, uvular R, the /s S f v z Z/ set,
 * stop bursts + VOT, codas, and melismas on the held notes.
 */

export interface Section {
  name: string;
  first: number; // first melody-note index (inclusive)
  last: number; // last melody-note index (exclusive)
  text: string; // human-readable, for the log
  lyrics: string; // phonemes
}

/**
 * Chorus — ORIGINAL test text on the refrain melody (32 notes). Like the verse,
 * these are original words written from scratch as a phonetic bench, matched to
 * the melody's syllable/melisma structure (not any recording's words).
 */
export const CHORUS: Section = {
  name: "chorus",
  first: 65,
  last: 97,
  text: "Je vois la mer, je vois la mer, je vois la mer / loin là, où va le vent / le temps s'en va / sans bruit ni fiiin",
  lyrics: [
    "Z @ . v w a . l a . m E R .", //  je vois la mer         65-68
    "Z @ . v w a . l a . m E R .", //  je vois la mer         69-72
    "Z @ . v w a . l a . m E R .", //  je vois la mer         73-76
    "l w E~ . - l a -", //             loin... là (2 melisma) 77-80
    "u . v a . l @ . v A~ - .", //     où va le vent          81-85
    "l @ . t A~ .", //                 le temps               86-87
    "s A~ . v a .", //                 s'en va                88-89
    "s A~ .", //                       sans                   90
    "b R w i .", //                    bruit                  91
    "n i .", //                        ni                     92
    "f E~ - - - .", //                 fiiin (3 melismas)     93-96
  ].join(" "),
};

/**
 * Verse — ORIGINAL test text on the verse melody (65 notes, two stanzas).
 * Stanza shape: 10 + 10 + 8 + 5 notes, then 10 + 10 + 8 + 4.
 */
export const VERSE: Section = {
  name: "verse",
  first: 0,
  last: 65,
  text:
    "Un enfant chante dans le vent / sa voix fragile cherche le jour / personne ne répond jamais / toujours plus loin // " +
    "je cherche encore les mots perdus / la nuit tombe sur la grande ville / personne ne viendra ce soir / et je m'endors",
  lyrics: [
    // --- stanza 1 ---
    // "Un enfant chante dans le vent" — nasal torture test: 6 nasal vowels        0-9
    "E~ . A~ . f A~ . S A~ . t @ - d A~ - l @ . v A~ .",
    // "sa voix fragile cherche le jour" — fricatives /s v f Z S/ + uvular R      10-19
    "s a . v w a . f R a . Z i . l @ - S E R . S @ . l @ . Z u R .",
    // "personne ne répond jamais" — stops, coda R, nasal /O~/                    20-27
    "p E R . s O . n @ . n @ . R e . p O~ . Z a . m E .",
    // "toujours plus loin" — clusters /pl/ /lw/, nasal /E~/                      28-32
    "t u . Z u R . p l y . l w E~ -",

    // --- stanza 2 ---
    // "je cherche encore les mots perdus" — /Z S/ + R codas                      33-42
    "Z @ . S E R . S @ . A~ . k O . R @ . l e . m o . p E R . d y .",
    // "la nuit tombe sur la grande ville" — /t d b g/ bursts + VOT               43-52
    "l a . n w i . t O~ . b @ . s y R . l a . g R A~ . d @ . v i . l @ .",
    // "personne ne viendra ce soir" — /vj/ glide, /dR/ cluster                   53-60
    "p E R . s O . n @ . n @ . v j E~ . d R a . s @ . s w a R .",
    // "et je m'endors" — nasal + coda R                                          61-64
    "e . Z @ . m A~ . d O R .", //   et je m'endors                            61-64
  ].join(" "),
};

export const SECTIONS: Record<string, Section> = {
  chorus: CHORUS,
  verse: VERSE,
  // the whole thing: verse then chorus, sung end to end
  all: {
    name: "all",
    first: 0,
    last: 97,
    text: `${VERSE.text} // ${CHORUS.text}`,
    // NB: each section's lyrics end on "." — otherwise joining them fuses
    // the last syllable of one into the first of the next ("d O R"+"k i" -> "dORki").
    lyrics: `${VERSE.lyrics} ${CHORUS.lyrics}`,
  },
};
