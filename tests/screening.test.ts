import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caught } from './helpers.ts';
import {
  assertNoHealthContent,
  assertSafeForVoice,
  screenForHealth,
  screenForIdentifiers,
  ScreenError,
} from '../src/domain/screening.ts';
import { CATEGORIES } from '../src/types.ts';
import { screenResult } from '../src/mcp/registry.ts';

test('health cannot be a category, whatever anyone configures', () => {
  const suspicious = /health|medic|dental|dentist|doctor|pharmac|care|clinic|hospital/i;
  for (const c of CATEGORIES) {
    assert.ok(!suspicious.test(c), `${c} looks like a health category`);
  }
});

test('health text is refused at the boundary and says what it matched', () => {
  const err = caught<ScreenError>(() => assertNoHealthContent('take her to the dentist and collect the prescription'));
  assert.equal(err.code, 'health_content');
  assert.deepEqual(err.matched.sort(), ['dentist', 'prescription']);
});

test('ordinary household work passes the health screen', () => {
  for (const ok of [
    'the dripping tap in the kitchen',
    'cutting the hedge at the front',
    'the boiler is making a noise',
    'a parcel is coming on Thursday',
    'the gutter over the back door is overflowing',
  ]) {
    assert.equal(screenForHealth(ok).clean, true, ok);
  }
});

test('the health screen matches whole words, so ordinary words are not false positives', () => {
  // "scan" is on the list; "scandinavian" and "scanner" must not trip it.
  for (const ok of [
    'the scandinavian wood burner',
    'the scanner in the study needs a plug socket',
    'a doser pump on the heating system',
  ]) {
    assert.equal(screenForHealth(ok).clean, true, ok);
  }
});

test('identifiers are caught by shape, not by a list of known values', () => {
  const cases: Array<[string, string]> = [
    ['ring 555 010 1234', 'phone number'],
    ['4111 1111 1111 1111', 'card number'],
    ['marian@ridgeway.invalid', 'email address'],
    ['the zip is 90210', 'postal code'],
    ['12 Ridgeway Road', 'street address'],
  ];
  for (const [text, expected] of cases) {
    const r = screenForIdentifiers(text);
    assert.equal(r.clean, false, text);
    assert.ok(r.matched.includes(expected), `${text} matched ${r.matched.join(', ')}`);
  }
});

test('a booking sentence with no identifiers in it is safe for voice', () => {
  assertSafeForVoice('Halloran Plumbing is coming on Thursday at eleven for the dripping tap');
});

test('the refusal never quotes the input back', () => {
  const err = caught<ScreenError>(() => assertNoHealthContent('her oncology appointment at the hospital on Tuesday'));
  assert.ok(!err.message.includes('Tuesday'));
  assert.ok(!err.message.includes('her'));
});

test('a brief the model wrote is screened before it can be spoken', () => {
  // `no-model-on-read-path` proves no bedrock module is reachable from the MCP server.
  // It cannot see a round trip through SQLite: the console writes the brief, a voice
  // turn reads the row back, and Alexa says it. The screen has to sit on the result,
  // not on the import graph.
  const spoken = {
    ok: true,
    code: 'brief',
    facts: {
      body: 'Marian has missed three visits and seems to be struggling with her medication.',
    },
  };
  const err = caught<ScreenError>(() => screenResult(spoken));
  assert.equal(err.code, 'health_content');
});

test('an ordinary brief still goes out', () => {
  const fine = {
    ok: true,
    code: 'brief',
    facts: { body: 'The plumber came on Thursday and the gutter work is booked for next week.' },
  };
  assert.equal(screenResult(fine).ok, true);
});

test('a health term at the end of a sentence is caught', () => {
  // `normalise` kept full stops, so ' doctor ' never matched 'the doctor.' and every
  // health term that ended a sentence went through. It failed towards doing nothing.
  for (const t of [
    'Marian is seeing the doctor.',
    'She needs her medication.',
    'Booked in for a scan.',
    'Pick up the prescription.',
  ]) {
    assert.equal(screenForHealth(t).clean, false, t);
  }
});

test('a hyphenated term still matches after normalising', () => {
  assert.equal(screenForHealth('she is booked for an x-ray').clean, false);
});

test('the false positives stay false', () => {
  // 'scandinavian' must not trip 'scan'. Whole words only, on both sides.
  for (const t of ['scandinavian furniture delivery', 'a doctorate ceremony', 'the gpu arrived']) {
    assert.equal(screenForHealth(t).clean, true, t);
  }
});

// ---------------------------------------------------------------------------
// §7 class 2: variants of everything the guard does catch.
//
// A table rather than thirty hand-written tests, and the ones that fail are the guard's
// real perimeter. Before §2 normalisation landed, every row below except `plain` passed.

const MUTATIONS: Array<[string, (s: string) => string]> = [
  ['plain', (s) => s],
  ['upper', (s) => s.toUpperCase()],
  ['title', (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())],
  ['curly apostrophe', (s) => s.replace(/'/g, '’')],
  ['spaced apostrophe', (s) => s.replace(/'/g, "' ")],
  ['zero width', (s) => s.replace(/ /g, '​ ')],
  ['zero width inside', (s) => s.replace(/([a-z])([a-z])/, '$1​$2')],
  ['cyrillic c', (s) => s.replace('c', 'с')],
  ['cyrillic o', (s) => s.replace('o', 'о')],
  ['cyrillic a', (s) => s.replace('a', 'а')],
  ['double spaced', (s) => s.replace(/ /g, '   ')],
  ['non-breaking space', (s) => s.replace(/ /g, ' ')],
  ['soft hyphen', (s) => s.replace(/([a-z])([a-z])/, '$1­$2')],
  ['accented', (s) => s.replace('e', 'é')],
];

const BLOCKED_BY_HEALTH = [
  'collect her prescription from the pharmacy',
  "the carer's booked time shows nothing at the door",
  'she is seeing the doctor on Tuesday',
  'booked in for a scan',
  'a district nurse is coming',
];

for (const sentence of BLOCKED_BY_HEALTH) {
  for (const [name, mutate] of MUTATIONS) {
    test(`the health screen sees through "${name}" in "${sentence.slice(0, 28)}..."`, () => {
      assert.equal(screenForHealth(mutate(sentence)).clean, false, mutate(sentence));
    });
  }
}

// §7 class 3: a paired false positive for every rule. The pair is what makes a rule
// legible rather than "reject anything that looks a bit like this".

test('the token rules have pairs: the ordinary word is not the health word', () => {
  const pairs: Array<[string, string]> = [
    ['scan', 'the scandinavian wood burner needs a new flue'],
    ['scan', 'the scanner in the study needs a plug socket'],
    ['dose', 'a doser pump on the heating system'],
    ['dose', 'the boiler is dosing the system with inhibitor'],
    ['surgery', 'the surge protector tripped again'],
    ['carer', 'the caretaker at the flats let him in'],
    ['gp', 'the gpu in the study needs a new fan'],
    ['doctor', 'a doctorate ceremony at the hall'],
    // Not "the medicine cabinet door": that contains the word and Standby refuses it,
    // which is the rule working. A pair has to be a near miss, not a true positive
    // somebody finds inconvenient.
    ['medicine', 'the medicinal herb bed by the back wall needs clearing'],
    ['dental', 'the dentil moulding above the porch is loose'],
    ['pills', 'the pillars either side of the gate need repointing'],
    ['therapy', 'the therapeutic pool at the leisure centre'],
  ];
  for (const [rule, clean] of pairs) {
    assert.equal(screenForHealth(clean).clean, true, `"${rule}" tripped on: ${clean}`);
  }
});

test('the dose shape has a pair: a number with a unit that is not a dose', () => {
  for (const clean of [
    'five metres of copper pipe',
    'a 5 amp fuse in the consumer unit',
    'the 90 minute slot on Thursday',
    'a 3 bar pressure test',
    'two radiators in the back room',
  ]) {
    assert.equal(screenForHealth(clean).clean, true, clean);
  }
  for (const blocked of ['take 5mg with food', 'two tablets in the morning', 'half a tablet at night']) {
    assert.equal(screenForHealth(blocked).clean, false, blocked);
  }
});

test('the emergency shape has a pair: a number that is not somebody being told to dial it', () => {
  for (const clean of [
    'invoice 999 is still unpaid',
    'the 911 model boiler is discontinued',
    'quote number 112 from the gutter people',
  ]) {
    assert.equal(screenForHealth(clean).clean, true, clean);
  }
  for (const blocked of ['ring 999 if it gets worse', 'call 911 straight away']) {
    assert.equal(screenForHealth(blocked).clean, false, blocked);
  }
});

test('the wellbeing rule has a pair: a thing can be struggling, a person cannot be said to be', () => {
  for (const clean of [
    'the boiler is struggling to hold pressure',
    'her fence fell down in the wind',
    'his shed fell over and needs rebuilding',
    'the shower is weak on the top floor',
    'the gate is wobbly on its hinges',
    'the tap is dripping and the washer is worn',
    'she is coming on Thursday to let the plumber in',
    'he is paying for the gutter work',
  ]) {
    assert.equal(screenForHealth(clean).clean, true, clean);
  }
  for (const blocked of [
    'she has been very shaky on her feet lately',
    'she had a fall on the stairs but is fine now',
    'he seems confused about the appointment',
    'she is doing so well she could let go of the chair now',
    'keep an eye on her while you are there',
  ]) {
    assert.equal(screenForHealth(blocked).clean, false, blocked);
  }
});

test('the identifier shapes see a folded copy as well as the raw one', () => {
  // NFKC turns full-width digits into digits, and dropping the zero-width family puts a
  // split number back together. Both are ways to read a card number to a speaker.
  const cases = [
    '５５５ ０１０ １２３４',
    '555​ 010​ 1234',
    '4111 1111 1111 1111',
  ];
  for (const text of cases) {
    assert.equal(screenForIdentifiers(text).clean, false, JSON.stringify(text));
  }
  // The pair: a reference number that is not any of those shapes still goes out.
  assert.equal(screenForIdentifiers('reference SB-X2TH').clean, true);
  assert.equal(screenForIdentifiers('90.00 dollars').clean, true);
});
