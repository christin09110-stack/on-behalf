// Normalisation for guard matching. Nothing this module returns is ever rendered,
// stored, spoken or logged as the text. It is a matching copy and only a matching copy.
//
// Why it exists, in one sentence: a guard that compares a list against raw model output
// is comparing against bytes the model picked. `she's`, `she’s`, `she' s`, `ѕhe's` with a
// Cyrillic s, and `s<ZWSP>he's` all have to reach the same comparison, or the list is
// decorative. This module is the port of that specification.
//
// The order below is load-bearing and it is the order that catches an uppercase Cyrillic
// lookalike: case-fold BEFORE folding the lookalike table, because `Ѕ` is not a key in it
// and `ѕ` is.
//
// Two forms come out, because one is not enough:
//   spaced   — apostrophes and hyphens become a space: "she's" -> "she s"
//   squeezed — they vanish:                            "she's" -> "shes"
// Membership is checked against the union. A guard with only `spaced` lets `did' not`
// through; a guard with only `squeezed` lets `non-attendance` hide `attendance`.

const INVISIBLE = /[­​‌‍⁠﻿‪-‮⁦-⁩]/g;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Latin lookalikes that spell English words. Deliberately not exhaustive: a fold table is
 * a denylist wearing different clothes, and `foreignLetters()` below is the allowlist that
 * catches whatever this map does not.
 */
const LOOKALIKE = new Map<string, string>(
  Object.entries({
    'а': 'a', 'б': 'b', 'е': 'e', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'ӏ': 'l', 'о': 'o',
    'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'һ': 'h', 'ԛ': 'q', 'ѡ': 'w',
    'ν': 'v', 'ο': 'o', 'ρ': 'p', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'τ': 't',
  }),
);

const PUNCT = new Map<string, string>(
  Object.entries({
    '‘': "'", '’': "'", '‚': "'", '‛': "'", 'ʼ': "'",
    '´': "'", '`': "'", '′': "'",
    '“': '"', '”': '"', '„': '"', '″': '"',
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
    '―': '-', '−': '-',
    ' ': ' ', ' ': ' ', ' ': ' ',
  }),
);

/** A matching copy. Never render the result of this. */
export function normalise(text: string): string {
  let s = text.normalize('NFKC').replace(INVISIBLE, '').replace(CONTROL, '');
  s = s.toLowerCase();
  s = s.normalize('NFD').replace(/\p{Mn}+/gu, '').normalize('NFC');
  s = [...s].map((c) => LOOKALIKE.get(c) ?? PUNCT.get(c) ?? c).join('');
  return s.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export interface Normalised {
  readonly original: string;
  readonly spaced: string;
  readonly squeezed: string;
  hasWord(word: string): boolean;
  hasPhrase(phrase: string): boolean;
  /** Letters that survived folding. Non-empty means somebody is trying. */
  foreignLetters(): string[];
}

export function prepare(text: string): Normalised {
  const n = normalise(text);
  const spaced = n.replace(/\s*['-]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const squeezed = n.replace(/\s*['-]\s*/g, '');
  const tokens = new Set(
    [...spaced.split(/[^a-z0-9]+/), ...squeezed.split(/[^a-z0-9]+/)].filter(Boolean),
  );
  return {
    original: text,
    spaced,
    squeezed,
    hasWord: (w: string) => {
      const m = normalise(w);
      return tokens.has(m) || tokens.has(m.replace(/['-]/g, ''));
    },
    hasPhrase: (p: string) => {
      const m = normalise(p);
      return (
        spaced.includes(m.replace(/['-]/g, ' ').replace(/\s+/g, ' ').trim()) ||
        squeezed.includes(m.replace(/['-]/g, ''))
      );
    },
    foreignLetters: () => [
      ...new Set([...squeezed].filter((c) => /\p{L}/u.test(c) && !/[a-z]/.test(c))),
    ],
  };
}
