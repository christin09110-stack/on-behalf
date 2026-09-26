// Screening: the two things Standby refuses to carry, enforced in code rather than
// in a README.
//
// 1. Health. Policy Requirement 13 governs health content, and the Alexa+ permissions
//    model grants one customer's data to an add-on on that customer's own account with
//    no documented way to delegate a second person's. So a medical appointment for
//    somebody who is not the linked account holder has no consent route that Amazon
//    has written down. Standby therefore has no health category and rejects health
//    text at the boundary. This is not a setting.
// 2. Identifiers. Policy Requirement 3 rejects an add-on that recites private personal
//    information by voice, and Requirement 14 rejects one that collects personal
//    identifiers in-experience. Requirement 15 separately *mandates* reading booking
//    details back. So the line Standby draws is: service facts go to the speaker,
//    identifiers go to the written channel only.

import { normalise, prepare } from './normalise.ts';

export interface ScreenResult {
  clean: boolean;
  /** The matched terms, so a refusal can say what it saw without quoting the input. */
  matched: string[];
  code: 'health_content' | 'identifier_in_voice' | null;
}

const HEALTH_TERMS = [
  'doctor',
  'doctors',
  'gp',
  'nurse',
  'hospital',
  'clinic',
  'surgery',
  'surgeon',
  'dentist',
  'dental',
  'optician',
  'optometrist',
  'podiatrist',
  'physio',
  'physiotherapy',
  'therapist',
  'therapy',
  'psychiatrist',
  'oncology',
  'oncologist',
  'cardiology',
  'chemo',
  'chemotherapy',
  'dialysis',
  'scan',
  'mri',
  'x-ray',
  'xray',
  'biopsy',
  'blood test',
  'bloods',
  'prescription',
  'prescriptions',
  'pharmacy',
  'pharmacist',
  'medication',
  'medicine',
  'medicines',
  'tablets',
  'pills',
  'dose',
  'dosage',
  'insulin',
  'inhaler',
  'diagnosis',
  'symptom',
  'symptoms',
  'appointment at the hospital',
  'care home',
  'carer',
  'district nurse',
  'ambulance',
];

/**
 * Three classes, rather than three more words.
 *
 * `HEALTH_TERMS` above is a denylist, and a denylist is a list of the sentences its
 * author imagined. Running the shared adversarial corpus at
 * `tests/fixtures/adversarial.jsonl` through it showed where that ends: "Ring 999 if it
 * gets worse", "She had a fall on the stairs but is fine now" and "She has been very
 * shaky on her feet lately" all passed a list containing `ambulance`, `hospital` and
 * `unsteady`, because none of them uses a word anybody thought to write down.
 *
 * The answer is not to add those three sentences. It is to name the class each one
 * belongs to, and these are the three Standby's promise actually depends on:
 *
 *   a dose      a quantity with a medical unit is a dosing instruction whatever the drug
 *               is called, and a drug-name list is infinite and Standby will not keep one
 *   an emergency  dialling the emergency number, or naming an emergency department
 *   a claim about how somebody is doing  a person, plus a word about their capacity.
 *               This is the one the footer on every page of the console promises: Standby
 *               does not speculate about health, wellbeing or whether someone is coping.
 *
 * The third needs both halves. "The boiler is struggling" is a plumbing job; "she is
 * struggling" is the sentence the brief must never contain. Requiring a person makes the
 * rule about the claim rather than about the adjective.
 */
const HEALTH_SHAPES: Array<[string, RegExp]> = [
  [
    'a dose',
    /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ug|ml|units?|tablets?|pills?|capsules?|puffs?|drops?|sachets?)\b/,
  ],
  [
    'a dose',
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|half a|a)\s+(?:tablets?|pills?|capsules?|puffs?|doses?|sachets?)\b/,
  ],
  ['an emergency instruction', /\b(?:ring|call|dial|phone)\s+(?:999|911|112)\b/],
  [
    'an emergency instruction',
    /\b(?:accident and emergency|a and e|emergency room|urgent care|walk in centre|out of hours)\b/,
  ],
];

/**
 * Somebody, rather than something. The subject half of the wellbeing rule.
 *
 * Subject forms only, and the possessives are deliberately absent. `her` and `his` attach
 * to objects as readily as to people — "her fence fell down", "his shed fell over" — and a
 * fence coming down is a household job, which is the product. Keeping the list to the
 * forms that can only be a person is what keeps the rule about the claim rather than
 * about the adjective.
 */
const A_PERSON =
  /\b(?:she|he|mum|mom|mother|dad|father|gran|granny|grandma|grandad|grandpa|nan|nana)\b/;

/** How they are getting on. The predicate half. Never fires without the subject half. */
const CAPACITY_WORDS = [
  'struggling', 'struggles', 'struggle', 'coping', 'cope', 'confused', 'confusion',
  'frail', 'unsteady', 'wobbly', 'shaky', 'weak', 'weaker', 'forgetful', 'forgetting',
  'declining', 'deteriorating', 'unwell', 'poorly', 'fell', 'fall', 'fallen', 'falls',
  'injured', 'hurt', 'bruised', 'dizzy', 'breathless', 'bedbound', 'housebound',
  'incontinent', 'agitated', 'distressed', 'wandering', 'recovering', 'recovery',
];

/**
 * Phrases that are only ever about a person, so they need no subject half. "Keep an eye
 * on her" has no reading in which the object is a boiler.
 */
const PERSON_CLAIM_PHRASES = [
  'not herself', 'not himself', 'on her feet', 'on his feet',
  'check on her', 'check on him', 'look in on her', 'look in on him',
  'keep an eye on her', 'keep an eye on him', 'how she is getting on',
  'how he is getting on',
];

/**
 * The predicate half again, as shapes rather than words, because an intensifier is the
 * cheapest way past a word list: `doing well` is on it and `doing so well` is not.
 *
 * The second shape is a different claim and a worse one — that somebody may stop using
 * something they were using. It is the sentence a care app must never generate, and it
 * reaches a speaker through the same field as everything else here.
 */
const CAPACITY_SHAPES: RegExp[] = [
  /\b(?:doing|getting|feeling|seeming|seems|looking|looks)\s+(?:so |very |really |quite |much |a lot |a bit |rather )?(?:well|better|worse|fine|poorly|frail|weak|confused|unsteady|wobbly)\b/,
  /\b(?:can|could|should|able to)\s+(?:now\s+)?(?:let go of|stop using|manage without|do without|get by without|stop taking)\b/,
];

/**
 * Identifiers that must never leave on the voice path. Each is a shape, not a list:
 * a long digit run, a card-like group, an email address, a street number with a
 * street word.
 */
const IDENTIFIER_PATTERNS: Array<[string, RegExp]> = [
  ['card number', /\b(?:\d[ -]?){13,19}\b/],
  ['phone number', /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/],
  ['email address', /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/],
  ['postal code', /\b\d{5}(?:-\d{4})?\b/],
  [
    'street address',
    /\b\d{1,5}\s+\w+(?:\s+\w+)?\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|way|close)\b/i,
  ],
];

/**
 * Run over anything a human typed or spoke before Standby stores it.
 *
 * Matching happens against the normalised copy built in `normalise.ts`, never against
 * the raw string. This screen used to lowercase, strip non-alphanumerics and compare —
 * which is enough for a person typing and useless against anything choosing its bytes.
 * `prescriptiоn` with a Cyrillic o, `pre​scription` with a zero-width space, `PHARMACY`
 * in full-width characters and `carer’s` with a curly apostrophe all reached a comparison
 * that could not see them.
 *
 * Single-word terms go through `hasWord`, so they match whole and `scandinavian` does not
 * trip `scan`. Multi-word terms go through `hasPhrase`, which checks both the spaced and
 * the squeezed form, so `x-ray`, `x ray` and `xray` are one term.
 */
/**
 * Whole-token phrase matching on the spaced form.
 *
 * `Normalised.hasPhrase` is a substring test, which is right for a guard that wants to
 * catch a phrase split across punctuation and wrong for a short one: "blood test" is
 * safe as a substring, "x ray" is not, because "bo**x ray**mond" contains it. Padding
 * both sides with a space turns the spaced form into a token sequence, and the test back
 * into one about words.
 */
function hasTokenPhrase(spaced: string, phrase: string): boolean {
  const needle = normalise(phrase).replace(/['-]/g, ' ').replace(/\s+/g, ' ').trim();
  return ` ${spaced} `.includes(` ${needle} `);
}

function matchesTerm(n: ReturnType<typeof prepare>, term: string): boolean {
  if (/\s/.test(term)) return hasTokenPhrase(n.spaced, term);
  // A hyphenated term is two spellings: "x-ray" and "xray". `hasWord` sees the second
  // through the squeezed form; the token phrase sees the first and "x ray" as well.
  if (term.includes('-')) return n.hasWord(term) || hasTokenPhrase(n.spaced, term);
  return n.hasWord(term);
}

function wellbeingClaim(n: ReturnType<typeof prepare>): boolean {
  if (PERSON_CLAIM_PHRASES.some((p) => hasTokenPhrase(n.spaced, p))) return true;
  if (!A_PERSON.test(` ${n.spaced} `)) return false;
  return (
    CAPACITY_WORDS.some((w) => n.hasWord(w)) || CAPACITY_SHAPES.some((re) => re.test(n.spaced))
  );
}

export function screenForHealth(text: string): ScreenResult {
  const n = prepare(text);
  const matched: string[] = HEALTH_TERMS.filter((t) => matchesTerm(n, t));
  for (const [name, re] of HEALTH_SHAPES) {
    if ((re.test(n.spaced) || re.test(n.squeezed)) && !matched.includes(name)) {
      matched.push(name);
    }
  }
  if (wellbeingClaim(n)) matched.push('a claim about how somebody is doing');
  return matched.length
    ? { clean: false, matched, code: 'health_content' }
    : { clean: true, matched: [], code: null };
}

/**
 * Run over everything Standby hands back to Alexa for the spoken turn.
 *
 * These are shapes rather than terms, so they run on the text itself — but on a folded
 * copy as well as the raw one, because `NFKC` turns full-width `５５５` into `555` and
 * dropping the zero-width family reassembles a digit run somebody split in half. A hit on
 * either copy is a hit: the raw pass is what keeps `12 Ridgeway Road` working when folding
 * would have changed the spacing.
 */
export function screenForIdentifiers(text: string): ScreenResult {
  const folded = normalise(text);
  const matched = IDENTIFIER_PATTERNS.filter(
    ([, re]) => re.test(text) || re.test(folded),
  ).map(([n]) => n);
  return matched.length
    ? { clean: false, matched, code: 'identifier_in_voice' }
    : { clean: true, matched: [], code: null };
}

export class ScreenError extends Error {
  code: NonNullable<ScreenResult['code']>;
  matched: string[];

  constructor(code: NonNullable<ScreenResult['code']>, matched: string[]) {
    super(
      code === 'health_content'
        ? `On Behalf does not handle health arrangements. It matched: ${matched.join(', ')}.`
        : `On Behalf will not put ${matched.join(' or ')} on the spoken channel.`,
    );
    this.name = 'ScreenError';
    this.code = code;
    this.matched = matched;
  }
}

/** Throws rather than returns, because every caller's correct response is to stop. */
export function assertNoHealthContent(text: string): void {
  const r = screenForHealth(text);
  if (!r.clean) throw new ScreenError('health_content', r.matched);
}

export function assertSafeForVoice(text: string): void {
  const r = screenForIdentifiers(text);
  if (!r.clean) throw new ScreenError('identifier_in_voice', r.matched);
}
