// §2 of the guard standard, ported and then checked against the outputs that document
// states. Those outputs came from running the Python version; these assert the
// TypeScript one agrees case for case, because the two implementations drifting apart is
// how a shared corpus stops meaning the same thing in two repos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, prepare } from '../src/domain/normalise.ts';

const ZWSP = '​';
const CYRILLIC_S = 'Ѕ'; // uppercase, which is the one that caught the fold order
const CYRILLIC_O = 'о';

test('every spelling of a contraction reaches the same comparison', () => {
  const cases: Array<[string, string]> = [
    ['plain', "She's not recorded at the front door at 8."],
    ['curly', 'She’s not recorded at the front door at 8.'],
    ['spaced', "She' s not recorded at the front door at 8."],
    ['zero-width', `S${ZWSP}he's not recorded`],
    ['lookalike', `${CYRILLIC_S}he's not recorded`],
    ['upper', "SHE'S NOT RECORDED"],
    ['full-width', 'Ｓｈｅ－s not recorded'],
  ];
  for (const [name, text] of cases) {
    assert.ok(prepare(text).hasWord('she'), `${name}: the pronoun was invisible`);
  }
});

test('a possessive does not swallow the word inside it', () => {
  assert.ok(prepare('The carer’s booked time shows nothing').hasWord("carer's"));
  assert.ok(prepare("The carer's booked time shows nothing").hasWord('carer'));
});

test('a phrase survives punctuation put inside it and whitespace stretched across it', () => {
  assert.ok(prepare("did' not come").hasPhrase('did not'));
  assert.ok(prepare('The  carer   did  not   come').hasPhrase('did not'));
  assert.ok(prepare('did‑not come').hasPhrase('did not'));
});

test('a hyphen does not hide the word after it', () => {
  assert.ok(prepare('non-attendance').hasWord('attendance'));
  assert.ok(prepare('non–attendance').hasWord('attendance'));
});

test('and the paired negative, which is what makes the rules legible', () => {
  // If these tripped, the normalisation would be matching by accident rather than by
  // word, and every rule built on it would be a false-positive generator.
  assert.equal(prepare("o'clock is fine").hasWord('she'), false);
  assert.equal(prepare('the shed is fine').hasWord('she'), false);
  assert.equal(prepare('she came').hasPhrase('did not'), false);
  assert.equal(prepare('attendance was good').hasWord('non-attendance'), false);
});

test('foreignLetters is the allowlist the fold table cannot be', () => {
  // A fold table is a denylist wearing different clothes. `dıd` with a dotless
  // Turkish i survives every map anybody writes, and this is what catches it anyway.
  assert.deepEqual(prepare('the carer did not come').foreignLetters(), []);
  assert.deepEqual(prepare(`the carer dıd not come`).foreignLetters(), ['ı']);
  // A lookalike that IS in the table is folded, so it does not show up here. Both
  // mechanisms have to be present: this one alone would call every Cyrillic o foreign
  // and that one alone would miss the next letter nobody listed.
  assert.deepEqual(prepare(`did n${CYRILLIC_O}t come`).foreignLetters(), []);
  assert.ok(prepare(`did n${CYRILLIC_O}t come`).hasPhrase('did not'));
});

test('normalising is idempotent, over a spread of inputs rather than one', () => {
  const inputs = [
    '',
    ' ',
    'plain text',
    "She’s  not​ recorded at 8",
    `${CYRILLIC_S}he—s`,
    'café naïve',
    'line one\n\n  line two  \n',
    'Ｓｈｅ',
    '‮reversed‬',
    '\u0000\u001B[31mred',
  ];
  for (const s of inputs) {
    assert.equal(normalise(normalise(s)), normalise(s), JSON.stringify(s));
  }
});

test('no invisible character can hide a phrase, wherever it is put', () => {
  const phrase = 'did not come';
  for (let i = 0; i <= phrase.length; i++) {
    const hidden = phrase.slice(0, i) + ZWSP + phrase.slice(i);
    assert.ok(prepare(`the carer ${hidden}`).hasPhrase(phrase), `zero width at ${i}`);
  }
  // And the version that spaces every character, which is the usual shape of the attack.
  const spread = [...phrase].map((c) => c + ZWSP).join('');
  assert.ok(prepare(spread).hasPhrase(phrase));
});

test('normalisation is a matching copy and never the text', () => {
  // The original is what gets kept. If a guard ever rendered `spaced` or `squeezed`, the
  // person reading it would be shown a sentence nobody wrote.
  const original = 'The carer’s  visit — Thursday';
  const n = prepare(original);
  assert.equal(n.original, original, 'the original was mutated');
  assert.notEqual(n.spaced, original);
  assert.notEqual(n.squeezed, original);
});

test('control characters and bidi overrides do not survive into the matching copy', () => {
  const n = normalise('the\u0000 carer\u001B[31m did‮ not come');
  assert.ok(!/[\u0000-\u001F‪-‮]/.test(n), `control survived: ${JSON.stringify(n)}`);
  assert.ok(prepare('the\u0000 carer did‮ not come').hasPhrase('did not'));
});
