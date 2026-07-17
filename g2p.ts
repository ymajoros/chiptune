/**
 * g2p.ts — crude French grapheme-to-phoneme.
 *
 * Deliberately a ruleset, not a dictionary: it gets the common cases and fails
 * on the rest. Real G2P needs a pronunciation lexicon (French orthography is
 * only ~90% predictable, and the exceptions are the frequent words). Use
 * explicit --phonemes when it matters.
 *
 * `frenchSyllable` handles a KARAOKE syllable rather than a word, which is a
 * different job: the syllable is a fragment ("d'ques", "tions", "vais"), so
 * word-final rules (silent consonants) may only be applied when the caller says
 * this fragment actually ends a word.
 */

/** Multi-letter graphemes, longest first — order matters. */
const RULES: [string, string[]][] = [
  ["eau", ["o"]],
  ["oeu", ["2"]],
  ["ain", ["E~"]],
  ["ein", ["E~"]],
  ["oin", ["w", "E~"]],
  ["ien", ["j", "E~"]],
  ["ion", ["j", "O~"]],
  ["au", ["o"]],
  ["ou", ["u"]],
  ["oi", ["w", "a"]],
  ["in", ["E~"]],
  ["im", ["E~"]],
  ["un", ["9~"]],
  ["um", ["9~"]],
  ["an", ["A~"]],
  ["am", ["A~"]],
  ["en", ["A~"]],
  ["em", ["A~"]],
  ["on", ["O~"]],
  ["om", ["O~"]],
  ["ai", ["E"]],
  ["ei", ["E"]],
  ["eu", ["2"]],
  ["ch", ["S"]],
  ["gn", ["N"]],
  ["qu", ["k"]],
  ["ph", ["f"]],
  ["th", ["t"]],
  ["ss", ["s"]],
  ["ll", ["l"]],
  ["mm", ["m"]],
  ["nn", ["n"]],
  ["tt", ["t"]],
  ["pp", ["p"]],
  ["rr", ["R"]],
  ["ff", ["f"]],
  ["cc", ["k"]],
  ["é", ["e"]],
  ["è", ["E"]],
  ["ê", ["E"]],
  ["ë", ["E"]],
  ["à", ["a"]],
  ["â", ["a"]],
  ["ç", ["s"]],
  ["û", ["y"]],
  ["ù", ["y"]],
  ["ô", ["o"]],
  ["î", ["i"]],
  ["ï", ["i"]],
];

const SINGLE: Record<string, string[]> = {
  a: ["a"], e: ["@"], i: ["i"], o: ["O"], u: ["y"], y: ["i"],
  b: ["b"], d: ["d"], f: ["f"], j: ["Z"], k: ["k"], l: ["l"], m: ["m"],
  n: ["n"], p: ["p"], r: ["R"], t: ["t"], v: ["v"], w: ["w"], z: ["z"],
  x: ["k", "s"],
};

/** Every phoneme that is a vowel — used to avoid stripping a syllable to nothing. */
const VOWELS = new Set(["a", "e", "E", "i", "o", "O", "u", "y", "2", "@", "A~", "O~", "E~", "9~"]);

/** Consonants commonly silent at the end of a French word. */
const SILENT_FINAL = ["t", "d", "s", "z", "p", "x", "n"];

/**
 * Phonemise one karaoke syllable.
 * @param raw      the syllable as written (may carry punctuation / a leading space)
 * @param wordEnd  true if this fragment ends a word — only then may a final
 *                 consonant be dropped, and only then is a final "e" mute.
 */
export function frenchSyllable(raw: string, wordEnd: boolean): string[] {
  const s = raw
    .toLowerCase()
    .replace(/[.,!?;:"“”()]/g, "")
    .replace(/[’']/g, "'")
    .trim();
  if (!s) return [];

  const FUNC: Record<string, string[]> = {
    les: ["l", "e"], des: ["d", "e"], mes: ["m", "e"], tes: ["t", "e"],
    ses: ["s", "e"], ces: ["s", "e"], es: ["e"], et: ["e"], est: ["E"],
  };
  if (wordEnd && FUNC[s]) return FUNC[s];

  const out: string[] = [];
  let i = 0;
  outer: while (i < s.length) {
    // an apostrophe is elision: "d'ques" -> /d/ + "ques". Just drop it.
    if (s[i] === "'" || s[i] === "-" || s[i] === " ") {
      i++;
      continue;
    }
    for (const [pat, ph] of RULES) {
      if (s.startsWith(pat, i)) {
        // "en"/"em" are only nasal before a consonant or at the end
        const after = s[i + pat.length];
        const nasal = ["ain", "ein", "oin", "ien", "ion", "in", "im", "un", "um", "an", "am", "en", "em", "on", "om"];
        if (nasal.includes(pat) && after && "aeiouyéèêh".includes(after)) break; // "bonne" -> /bɔn/, not /bɔ̃/
        out.push(...ph);
        i += pat.length;
        continue outer;
      }
    }
    const c = s[i];
    const next = s[i + 1] ?? "";
    // NB: "".includes("") is true, so guard `next` — a word-final c/g has no
    // next letter and is hard (/k/, /g/), not soft (/s/, /ʒ/).
    // c' is elided "ce" -> /s/ ("c'que" = /skə/); else soft before e/i/y.
    if (c === "c") out.push(next === "'" ? "s" : next && "eiyéè".includes(next) ? "s" : "k");
    else if (c === "g") out.push(next && "eiyéè".includes(next) ? "Z" : "g");
    else if (c === "s") {
      // s between vowels is /z/
      const prev = s[i - 1] ?? "";
      out.push(/[aeiouyéèêà]/.test(prev) && /[aeiouyéèêà]/.test(next) ? "z" : "s");
    } else if (c === "h") {
      /* silent */
    } else if (c === "e") {
      /**
       * French "e": /ɛ/ in a CLOSED syllable (one that ends in a consonant),
       * /ə/ in an OPEN one, mute word-finally. Word-by-word you cannot tell —
       * but a karaoke file hands you the sung syllable boundaries, so "ques"
       * (closed) -> /kɛs/ while "te" (open) -> /tə/ falls out for free.
       */
      const rest = s.slice(i + 1).replace(/'/g, "");
      const closed = rest.length > 0 && !/[aeiouyéèêàâôîïüû]/.test(rest);
      const hasVowel = out.some((ph) => VOWELS.has(ph));
      if (wordEnd && i === s.length - 1 && hasVowel) {
        /* mute final e */
      } else if (wordEnd && (rest === "r" || rest === "z")) {
        out.push("e"); // -er / -ez  ->  /e/
        i = s.length;
        break;
      } else out.push(closed ? "E" : "@");
    } else if (SINGLE[c]) out.push(...SINGLE[c]);
    i++;
  }

  /**
   * Silent final consonants. Decided on the SPELLING, not the phonemes: "pose"
   * ends orthographically in "e", so its /z/ is not final and must survive —
   * checking the last phoneme instead ate it. French also drops whole final
   * clusters ("grands" -> /gʁɑ̃/, both d and s), so strip repeatedly, never past
   * the last vowel.
   */
  if (wordEnd && /[bcdfgpstxz]$/.test(s)) {
    while (out.length > 1 && SILENT_FINAL.includes(out[out.length - 1])) {
      if (!out.slice(0, -1).some((ph) => VOWELS.has(ph))) break;
      out.pop();
    }
  }
  return out;
}

/** Phonemise a whole word (used by voice.ts --say). */
export function frenchWord(word: string): string[] {
  return frenchSyllable(word, true);
}
