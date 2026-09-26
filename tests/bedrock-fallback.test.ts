// Every model call in Standby has to work with the model switched off, because a demo
// that dies without a network is a demo that dies in front of somebody. These run with
// STANDBY_NO_MODEL=1, so no request leaves the machine.

process.env.STANDBY_NO_MODEL = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, MARIAN, NADIA, RIDGEWAY } from './helpers.ts';
import { draftTerms, droppedNotice, fallbackTerms } from '../src/bedrock/terms.ts';
import { adjudicate, gather } from '../src/bedrock/adjudicate.ts';
import { gatherBrief, writeBrief } from '../src/bedrock/brief.ts';
import { ask, firstJson, ModelUnavailable, plainPunctuation } from '../src/bedrock/client.ts';
import { requestService } from '../src/domain/visits.ts';
import { decideRequest, pendingFor } from '../src/domain/decisions.ts';
import { getChange } from '../src/domain/store.ts';

const marian = { account: MARIAN, surface: 'voice' as const };
const nadia = { account: NADIA, surface: 'touch' as const };

test('the client refuses rather than hanging when models are switched off', async () => {
  await assert.rejects(() => ask({ system: 's', user: 'u' }), ModelUnavailable);
});

test('drafting terms falls back to keywords and says so', async () => {
  const drafted = await draftTerms('I do the boiler and the garden, nothing over 150 dollars');
  assert.equal(drafted.fromFallback, true);
  assert.equal(drafted.model, null);
  assert.deepEqual(drafted.terms.categories.sort(), ['gardening', 'heating']);
  assert.equal(drafted.terms.spendCapCents, 15_000);
});

test('the keyword draft refuses to grant cancelling unless it was asked for', () => {
  assert.equal(fallbackTerms('I do the boiler').terms.mayCancel, false);
  assert.equal(fallbackTerms('I do the boiler and can cancel visits').terms.mayCancel, true);
});

test('the keyword draft drops health, and the notice is this app\'s sentence not a model\'s', () => {
  const d = fallbackTerms('the boiler, the garden, and taking her to the dentist');
  // A reason code, not a sentence. The model has no field here to write one in, so it
  // cannot write "nothing was dropped, medication pickups are covered under delivery".
  assert.deepEqual(d.dropped, ['health']);
  assert.match(droppedNotice('health'), /does not cover health/);
  assert.ok(!d.terms.categories.some((c) => /dent|health|medic/.test(c)));
});

test('an adjudication is still written, is marked as a fallback, and is never blank', async () => {
  const db = world({ withVisits: false });
  requestService(db, marian, RIDGEWAY, 'gutters', 'the gutter is overflowing');
  const changeId = pendingFor(db, NADIA)[0]!.change.id;
  const adj = await adjudicate(db, gather(db, NADIA, changeId)!);
  assert.equal(adj.fromFallback, true);
  assert.equal(adj.recommendation, 'ask_the_household');
  assert.ok(adj.headline.length > 10);
  assert.ok(adj.reasons.length >= 2);
  assert.equal(getChange(db, changeId)!.adjudication!.fromFallback, true);
});

test('the model advises and never acts: approving overrides its recommendation', async () => {
  const db = world({ withVisits: false });
  requestService(db, marian, RIDGEWAY, 'gardening', 'the hedge needs cutting');
  const changeId = pendingFor(db, NADIA)[0]!.change.id;
  const change = getChange(db, changeId)!;
  change.adjudication = {
    recommendation: 'decline',
    headline: 'A stub recommendation that says no.',
    reasons: ['stub'],
    risks: [],
    fromFallback: false,
    model: 'stub',
    latencyMs: 1,
  };
  db.prepare('UPDATE change_request SET adjudication = ? WHERE id = ?').run(
    JSON.stringify(change.adjudication),
    changeId,
  );

  const result = decideRequest(db, nadia, changeId, 'approve');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'booked');
});

test('the brief falls back to the plain ledger and marks itself', async () => {
  const db = world();
  const result = await writeBrief(gatherBrief(db, NADIA, RIDGEWAY));
  assert.equal(result.fromFallback, true);
  assert.ok(result.body.includes('Ridgeway'));
  assert.ok(result.body.length > 40);
});

test('the brief says so plainly when there is nothing to report', async () => {
  const db = world({ propose: false, withVisits: false });
  const result = await writeBrief(gatherBrief(db, NADIA, RIDGEWAY));
  assert.match(result.body, /Nothing has changed/);
});

test('JSON is recovered from a reply that chats before it answers', () => {
  const parsed = firstJson<{ a: number }>('Sure, here you go:\n{"a": 1, "b": "}"}\nhope that helps');
  assert.equal(parsed.a, 1);
});

test('model punctuation is normalised, because nothing here uses em dashes', () => {
  assert.equal(plainPunctuation('at 5pm—confirm someone is home'), 'at 5pm, confirm someone is home');
  assert.equal(plainPunctuation('“quoted”'), '"quoted"');
});
