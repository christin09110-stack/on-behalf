// The readback contract.
//
// Two Amazon facts collide here and the contract is what falls out of the collision.
//
// You cannot script what Alexa says. The Tools, Schema and Data Design page is blunt:
// "You can't 'script' what Alexa says", and the Conversation Surface page says Alexa+
// "incorporates your returned data into the voice response". The model writes the
// sentence.
//
// And yet Policy Requirement 15 says a booking add-on "must confirm relevant booking
// details via voice before executing", and must "read back booking details and
// cancellation policy" before a cancellation.
//
// So Standby cannot guarantee a sentence. What it can guarantee is the set of facts
// the sentence is composed from: that every required fact is present, that each one is
// true on its own in any order, and that nothing in the set is an instruction to the
// model or an identifier that should not be spoken. This module enforces that, and
// every tool result on the voice path goes through it.
//
// Two of the rules below are different in kind, and separating them is a fix rather than
// tidying.
//
//   `assertNoDirective` is a prompt-injection defence. It belongs on *everything* bound
//   for the speaker, because the hazard is somebody else's words arriving in the data,
//   and it is applied in `screenResult` where every tool result passes.
//
//   `assertReadbackSafe` is the Policy Requirement 15 contract for a *fact set*: these
//   named facts are present, and each stands alone in any order. That is a statement
//   about a booking readback, not about a paragraph, so it stays at the call sites that
//   compose one.
//
// They used to be one function, applied at seven call sites inside `src/domain/`, every
// one of which hands it facts this app's own rules composed. The one tool whose facts a
// model wrote — `latest_brief`, reading back prose stored by the console and spoken by
// Alexa — was not among them. The guard was correct, well tested, and pointed at the
// only text in the product that could not attack it.

import { screenForIdentifiers } from './screening.ts';
import { prepare } from './normalise.ts';

/** A fact is a label and a value that is true standing alone. */
export type FactSet = Record<string, string | number | boolean | null>;

export const BOOKING_FACTS = [
  'provider',
  'service',
  'day',
  'time',
  'price',
  'reference',
] as const;

export const CANCELLATION_FACTS = [
  'provider',
  'service',
  'day',
  'time',
  'cancellationPolicy',
  'cancellationCost',
] as const;

/**
 * Phrases that would be an attempt to drive the model rather than inform it.
 *
 * Matched against the normalised copy from `normalise.ts`, never against the raw string.
 * Before that change every one of these was a regex over bytes the author of the text
 * chose, so `ignоre` with a Cyrillic o, `re peat`, `IGNORE`, a curly apostrophe or a
 * zero-width space inside the word walked through all ten of them.
 *
 * Words are matched whole and phrases are matched with apostrophes and hyphens folded
 * both ways, so "do not mention" also catches "don't mention" and "do-not-mention".
 */
const DIRECTIVE_WORDS = ['verbatim'];

/**
 * Every entry is a frame rather than a word, and that is deliberate.
 *
 * The first version of this list carried bare `say`, `ignore` and `tell the`, which are
 * three of the commonest things a person writes in a note about their own house. "Tell
 * the plumber to come round the back" and "ignore the doorbell, it is broken" are the
 * product, not an attack, and a guard that refuses them is a guard somebody turns off.
 *
 * An instruction aimed at the assistant has a shape: it disregards what came before, or
 * it dictates the words to use. That shape is what is listed, and the paired false
 * positives in `tests/readback.test.ts` are what keep it honest.
 */
const DIRECTIVE_PHRASES = [
  'ignore the above',
  'ignore all',
  'ignore any',
  'ignore previous',
  'ignore everything',
  'ignore your',
  'disregard the above',
  'disregard all',
  'disregard previous',
  'disregard everything',
  'word for word',
  'you must',
  'do not mention',
  'new instructions',
  // Plural only. "A new instruction manual came with the oven" is a note somebody would
  // really write, and the paired false-positive test is what found that.
  'system prompt',
  'your instructions',
  'respond with',
  'reply with',
  'say the following',
  'read the following',
  'repeat the following',
  'repeat after me',
  'repeat this exactly',
  'instead of the above',
  'as an ai',
  'from now on you',
  'override the above',
];

/**
 * A fact that only makes sense next to another fact is a fact the model can reorder
 * into a falsehood. These are the shapes that do that.
 */
const ORDER_DEPENDENT = [
  /^\s*(and|then|also|after that|but|so)\b/i,
  /\b(the (former|latter)|as above|see below|that one|this one)\b/i,
  /\b(it|they|he|she) (is|are|was|were|will)\b/i,
];

export type ReadbackCode = 'missing_fact' | 'directive' | 'order_dependent' | 'identifier';

/**
 * Two payloads, per §6 of the guard standard. `rule` and `field` are written by this
 * app and are safe to render or speak. `message` carries the offending text and goes to
 * a developer's log and nowhere else.
 */
export class ReadbackError extends Error {
  code: ReadbackCode;
  field: string;

  constructor(code: ReadbackCode, field: string, detail: string) {
    super(detail);
    this.name = 'ReadbackError';
    this.code = code;
    this.field = field;
  }
}

/**
 * The prompt-injection rule, on its own so it can be applied to everything.
 *
 * The field name is app-authored and the sentence names the rule, so the refusal can be
 * shown to a person or handed to Alexa without reprinting a word of what was refused.
 */
export function assertNoDirective(field: string, value: string): void {
  const n = prepare(value);
  const hit =
    DIRECTIVE_WORDS.find((w) => n.hasWord(w)) ?? DIRECTIVE_PHRASES.find((p) => n.hasPhrase(p));
  if (hit !== undefined) {
    throw new ReadbackError(
      'directive',
      field,
      `"${field}" reads like an instruction to Alexa rather than a fact for it. Alexa composes its own sentence, so an instruction in the data is at best ignored and at worst spoken aloud. It matched the rule for ${JSON.stringify(hit)}.`,
    );
  }
  // A fold table is a denylist wearing different clothes: `dıd` with a dotless Turkish i
  // survives every map anybody writes. These fields are English, composed by this app or
  // by a model prompted in English, so a letter that is still not in a-z after folding is
  // either a language the guard was never written for or somebody probing it.
  const foreign = n.foreignLetters();
  if (foreign.length) {
    throw new ReadbackError(
      'directive',
      field,
      `"${field}" contains letters outside the alphabet this guard reads, so it cannot be checked: ${JSON.stringify(foreign)}.`,
    );
  }
}

/**
 * Validate a fact set bound for the spoken turn.
 *
 * @param facts the structured data the tool is about to return
 * @param requires the facts Policy Requirement 15 makes mandatory for this action
 */
export function assertReadbackSafe(facts: FactSet, requires: readonly string[] = []): void {
  for (const key of requires) {
    const v = facts[key];
    if (v === undefined || v === null || v === '') {
      throw new ReadbackError(
        'missing_fact',
        key,
        `The spoken turn needs ${key} and it is missing. Alexa composes the sentence, so a fact that is absent cannot be recovered later.`,
      );
    }
  }
  for (const [key, value] of Object.entries(facts)) {
    if (typeof value !== 'string') continue;
    assertNoDirective(key, value);
    for (const re of ORDER_DEPENDENT) {
      if (re.test(value)) {
        throw new ReadbackError(
          'order_dependent',
          key,
          `"${key}" only reads correctly next to another field. Alexa may use these facts in any order, so each one has to be true on its own.`,
        );
      }
    }
    if (!screenForIdentifiers(value).clean) {
      throw new ReadbackError(
        'identifier',
        key,
        `"${key}" contains an identifier. Identifiers go to the written channel, never to the speaker.`,
      );
    }
  }
}

/** Convenience for money, which is a fact people get wrong when they format it late. */
export function money(cents: number): string {
  return `${(cents / 100).toFixed(2)} dollars`;
}
