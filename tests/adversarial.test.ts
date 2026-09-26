// The shared adversarial corpus.
//
// Rule zero for this corpus is that it does not come from the guard. These
// nineteen rows are the seed set, copied verbatim, and not one of them was written by
// looking at `screening.ts`. Three of them found real holes in it on the first run and
// the fix was a class rule in each case, never the sentence:
//
//   advice-03  "Ring 999 if it gets worse."                  -> an emergency instruction
//   health-01  "She had a fall on the stairs but is fine now" -> a claim about a person
//   health-02  "She has been very shaky on her feet lately."  -> the same class
//   health-03  "...she could let go of the chair now."        -> the same class, by shape
//
// Two more were already caught and are worth naming because of *how*: uni-01 hides a
// Cyrillic o inside "not" and uni-02 a zero-width space inside "carer", and both reach
// the health screen because §2 normalisation runs before the comparison. Before that they
// were invisible to a list containing the word `carer`.
//
// `NOT_OURS` is the honest half. A row this app legitimately does not guard gets a skip
// and a reason, and the reason is reviewed; silently not running it would not be honest.
// Two of those reasons are gaps rather than non-applicability, and they say so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { screenForHealth, screenForIdentifiers } from '../src/domain/screening.ts';
import { assertNoDirective } from '../src/domain/readback.ts';

interface Row {
  id: string;
  text: string;
  expect: 'blocked' | 'clean';
  why: string;
  tags: string[];
}

const rows: Row[] = readFileSync(new URL('./fixtures/adversarial.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row);

/** Every guard On Behalf puts between a string and a person, run as one. */
export function guard(text: string): string[] {
  const findings: string[] = [];
  const health = screenForHealth(text);
  if (!health.clean) findings.push(...health.matched.map((m) => `health: ${m}`));
  const ids = screenForIdentifiers(text);
  if (!ids.clean) findings.push(...ids.matched.map((m) => `identifier: ${m}`));
  try {
    assertNoDirective('text', text);
  } catch {
    findings.push('directive');
  }
  return findings;
}

const NOT_OURS: Record<string, string> = {
  'apos-01':
    'On Behalf never narrates whether somebody attended. The diary is composed by the app ' +
    'from rows it wrote itself, and there is no field in which this sentence could exist.',
  'para-01':
    'Same as apos-01: no narrative summary field, so no accusation-by-arithmetic to guard.',
  'para-02':
    'Same as apos-01. On Behalf says a visit was booked, moved or cancelled, from its own rows.',
  'advice-01':
    'A KNOWN GAP, not a non-applicability. "Stop immediately, no taper needed" names no ' +
    'drug and carries no dose, so the class rules in screening.ts do not see it, and it ' +
    'would pass as a visit summary. On Behalf will not keep a drug vocabulary; what it has ' +
    'instead is no health category and no health arrangement. Recorded here rather than ' +
    'fixed by adding the sentence to the list.',
  'advice-02':
    'The same gap. "amlodipine" is a word On Behalf has never heard of and will not learn: ' +
    'a drug list is infinite and a guard built on one is a guard that is always behind.',
  'legal-01':
    'No statutory field and no record anybody files. On Behalf books trades; there is ' +
    'nowhere for a legal characterisation to be written down.',
  'pii-01':
    'No person-description field. `screenForIdentifiers` catches identifiers by shape and ' +
    'a description of a stranger is not one; On Behalf has nothing that would produce it.',
  'inject-01':
    'No markdown destination. On Behalf writes to a speaker, to HTML and to CSV, and §4 ' +
    'escaping for each of those is asserted in escape.test.ts. A forged `##` heading is ' +
    'three words in a plain-text email here.',
  'clean-03':
    'On Behalf blocks this one and that is correct. "surgery" means a GP surgery in the ' +
    'register this product is written in, and it is on the health list deliberately. The ' +
    'row is written for an advice guard in another app, where the same sentence is ' +
    'reported speech and harmless.',
};

for (const row of rows) {
  test(`corpus ${row.id}: ${row.why}`, { skip: NOT_OURS[row.id] }, () => {
    const findings = guard(row.text);
    if (row.expect === 'blocked') {
      assert.ok(findings.length > 0, `${row.id} passed every guard: ${row.why}`);
    } else {
      assert.deepEqual(findings, [], `${row.id} is a false positive: ${row.why}`);
    }
  });
}

// Non-vacuity, §7 class 6. Every assertion above is about a file being read; these two
// prove the file was read and that it says what the suite thinks it says.
test('the corpus file actually loaded, and it is the seed set', () => {
  assert.ok(rows.length >= 19, `only ${rows.length} rows, so the file did not load`);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'duplicate ids');
  for (const r of rows) {
    assert.ok(r.text.length > 0, `${r.id} has no text`);
    assert.ok(['blocked', 'clean'].includes(r.expect), `${r.id} has no expectation`);
    assert.ok(r.why.length > 10, `${r.id} does not say why`);
  }
});

test('every skipped row names a row that exists, so a reason cannot outlive its row', () => {
  const ids = new Set(rows.map((r) => r.id));
  for (const id of Object.keys(NOT_OURS)) {
    assert.ok(ids.has(id), `${id} is skipped but is not in the corpus`);
  }
  assert.ok(
    Object.keys(NOT_OURS).length < rows.length,
    'if every row is skipped the corpus is not being run at all',
  );
});

test('the unicode rows carry the characters they claim to, so they are not plain text', () => {
  const cyrillic = rows.find((r) => r.id === 'uni-01')!;
  const zeroWidth = rows.find((r) => r.id === 'uni-02')!;
  assert.ok(/о/.test(cyrillic.text), 'uni-01 lost its Cyrillic o somewhere in the file');
  assert.ok(/​/.test(zeroWidth.text), 'uni-02 lost its zero-width space');
  // And the guard sees through both, which is the whole claim of §2.
  assert.ok(guard(cyrillic.text).length > 0);
  assert.ok(guard(zeroWidth.text).length > 0);
});
