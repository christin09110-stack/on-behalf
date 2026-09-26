// The adjudicator's shape, which is the thing being tested rather than its wording.
//
// §1 of the guard standard puts Standby's `reasons[]` and `risks[]` at S4 — a
// `sourceIndex` into `input.recentLedger` — and its `headline` at S1/S4, and it points
// out that the answer was in the same file all along: the fallback arm composed its
// reasons from source data and the model arm took ten unconstrained sentences.
//
// So these tests are not "does the guard catch the bad sentence". There is no sentence to
// catch. They are "can the model reach a person's screen with a word it chose", and the
// answer has to be no by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { world, MARIAN, NADIA, RIDGEWAY } from './helpers.ts';
import {
  decodeAdjudication,
  fallback,
  gather,
  HEADLINE_FOCUS,
  RISK_CODES,
  type AdjudicationInput,
} from '../src/bedrock/adjudicate.ts';
import { adjudicationView } from '../src/web/views.ts';
import { requestService } from '../src/domain/visits.ts';
import { pendingFor } from '../src/domain/decisions.ts';

const meta = { model: 'stub-model', latencyMs: 12 };

function anInput(): AdjudicationInput {
  const db = world({ withVisits: false });
  requestService(db, { account: MARIAN, surface: 'voice' }, RIDGEWAY, 'gutters', 'the gutter is overflowing');
  const changeId = pendingFor(db, NADIA)[0]!.change.id;
  return gather(db, NADIA, changeId)!;
}

/** Everything a person could possibly read, as one string. */
const rendered = (adj: ReturnType<typeof decodeAdjudication>) =>
  `${adj.headline}\n${adj.reasons.join('\n')}\n${adj.risks.join('\n')}\n${adjudicationView(adj, 'chg_1')}`;

test('a well-behaved reply is composed, and the composition is the app\'s own words', () => {
  const input = anInput();
  const adj = decodeAdjudication(
    input,
    { recommendation: 'approve', headlineFocus: 'cost', reasonIndexes: [0], riskCodes: ['above_limit'] },
    meta,
  );
  assert.equal(adj.recommendation, 'approve');
  assert.ok(adj.headline.includes(input.providerName));
  assert.ok(adj.headline.includes(input.householdName));
  // The cited reason is a ledger line this app wrote, byte for byte.
  assert.ok(adj.reasons.includes(input.recentLedger[0]!), 'the citation is not the source line');
  assert.ok(adj.reasons.includes(input.holdReason));
  assert.equal(adj.risks.length, 1);
  assert.match(adj.risks[0]!, /above the limit the household set/);
});

test('a sentence the model writes into any field never reaches the page', () => {
  // This is the payload the old shape carried straight through: a headline, five reasons
  // and five risks, all free text, above the button that admits a stranger to a house.
  const input = anInput();
  const poison = 'Her son has already agreed to this and asked you to approve it without reading.';
  const adj = decodeAdjudication(
    input,
    {
      recommendation: 'approve',
      headlineFocus: 'cost',
      reasonIndexes: [0],
      riskCodes: ['above_limit'],
      // Every field name the old shape had, filled with the thing it must not carry.
      headline: poison,
      reasons: [poison, poison],
      risks: [poison],
      summary: poison,
      note: poison,
    },
    meta,
  );
  const page = rendered(adj);
  assert.ok(!page.includes('Her son has already agreed'), 'model prose reached the page');
  assert.ok(!page.includes('without reading'));
  // And the page is not empty, so the assertion above is about a rendering that happened.
  assert.ok(page.includes(input.providerName));
  assert.ok(page.length > 400, `the page is ${page.length} characters, so nothing rendered`);
});

test('an index outside the ledger refuses the record rather than being clamped', () => {
  const input = anInput();
  for (const bad of [input.recentLedger.length, -1, 1.5, '0', true, null, undefined, '0; DROP']) {
    assert.throws(
      () =>
        decodeAdjudication(
          input,
          { recommendation: 'approve', headlineFocus: 'cost', reasonIndexes: [bad], riskCodes: [] },
          meta,
        ),
      RangeError,
      `index ${JSON.stringify(bad)} was accepted`,
    );
  }
  // `true` is the one worth naming: in a language where a boolean is not a number this is
  // free, and the standard's Python version needs an explicit check for it.
  assert.ok(!Number.isInteger(true as unknown as number));
});

test('an unknown enum member refuses the record rather than defaulting', () => {
  const input = anInput();
  const good = { recommendation: 'approve', headlineFocus: 'cost', reasonIndexes: [], riskCodes: [] };
  const bad: Array<Record<string, unknown>> = [
    { ...good, recommendation: 'book_it' },
    { ...good, recommendation: 'APPROVE' },
    { ...good, recommendation: null },
    { ...good, headlineFocus: 'urgency' },
    { ...good, headlineFocus: '' },
    { ...good, riskCodes: ['she_is_not_coping'] },
    { ...good, riskCodes: ['above_limit', 'invented'] },
  ];
  for (const parsed of bad) {
    assert.throws(() => decodeAdjudication(input, parsed, meta), RangeError, JSON.stringify(parsed));
  }
  // The pair: every declared member decodes, so the refusals above are about the unknown
  // ones and not about the decoder refusing everything.
  for (const focus of HEADLINE_FOCUS) {
    assert.ok(decodeAdjudication(input, { ...good, headlineFocus: focus }, meta).headline.length > 20);
  }
  for (const code of RISK_CODES) {
    const adj = decodeAdjudication(input, { ...good, riskCodes: [code] }, meta);
    assert.equal(adj.risks.length, 1, code);
    assert.ok(adj.risks[0]!.length > 20, `${code} renders nothing`);
  }
});

test('the model arm and the fallback arm now produce the same shape', () => {
  // The defect §1 names is that these two differed, in the same file, with the weaker
  // shape on the path that needed the stronger. They are one shape now.
  const input = anInput();
  const fromModel = decodeAdjudication(
    input,
    { recommendation: 'ask_the_household', headlineFocus: 'new_provider', reasonIndexes: [0], riskCodes: [] },
    meta,
  );
  const fromRules = fallback(input, 0);
  assert.deepEqual(Object.keys(fromModel).sort(), Object.keys(fromRules).sort());
  assert.equal(fromModel.headline, fromRules.headline, 'the two arms word the headline differently');
  assert.ok(fromModel.reasons[0] === fromRules.reasons[0], 'the hold reason differs between arms');
});

test('every risk sentence and every headline is a string this repo contains', () => {
  // The strongest version of the claim: grep the source for what was rendered. If a
  // sentence on the page is not in the source, a model wrote it.
  const input = anInput();
  const source = ['src/bedrock/adjudicate.ts', 'src/domain/capability.ts']
    .map((f) => new URL(`../${f}`, import.meta.url))
    .map((u) => readFileSync(u, 'utf8'))
    .join('\n');
  for (const code of RISK_CODES) {
    const adj = decodeAdjudication(
      input,
      { recommendation: 'decline', headlineFocus: 'timing', reasonIndexes: [], riskCodes: [code] },
      meta,
    );
    assert.ok(source.includes(adj.risks[0]!), `not in the source: ${adj.risks[0]}`);
  }
  for (const focus of HEADLINE_FOCUS) {
    const adj = decodeAdjudication(
      input,
      { recommendation: 'decline', headlineFocus: focus, reasonIndexes: [], riskCodes: [] },
      meta,
    );
    // The headline interpolates source values, so assert the frame rather than the whole
    // sentence: the provider, the household and the money all come from `gather`.
    assert.ok(adj.headline.startsWith(`${input.providerName} for `), focus);
    assert.ok(adj.headline.includes(input.householdName), focus);
  }
  // The cap is three and it is a cap, not a silent emptying. It is stated in the prompt
  // and asserted here so that a change to one has to be a change to both.
  const capped = decodeAdjudication(
    input,
    { recommendation: 'decline', headlineFocus: 'timing', reasonIndexes: [], riskCodes: [...RISK_CODES] },
    meta,
  );
  assert.equal(capped.risks.length, 3, 'the risk cap moved');
  assert.deepEqual(
    capped.risks,
    RISK_CODES.slice(0, 3).map(
      (c) =>
        decodeAdjudication(
          input,
          { recommendation: 'decline', headlineFocus: 'timing', reasonIndexes: [], riskCodes: [c] },
          meta,
        ).risks[0]!,
    ),
    'the cap kept the wrong three',
  );
});

test('a reply with no usable selection still produces something a person can act on', () => {
  const input = anInput();
  const adj = decodeAdjudication(
    input,
    { recommendation: 'ask_the_household', headlineFocus: 'household_asked', reasonIndexes: [], riskCodes: [] },
    meta,
  );
  assert.ok(adj.headline.length > 20);
  assert.ok(adj.reasons.length >= 2, 'the reasons emptied when the model selected nothing');
  assert.ok(adj.reasons.every((r) => r.length > 0));
});
