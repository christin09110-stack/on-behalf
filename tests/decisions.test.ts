import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caught, world, MARIAN, NADIA, RIDGEWAY } from './helpers.ts';
import { requestService } from '../src/domain/visits.ts';
import { decideRequest, pendingFor } from '../src/domain/decisions.ts';
import { getChange, getVisit, outbox, auditFor, saveGrant, grantsOverHousehold } from '../src/domain/store.ts';
import { StandbyError } from '../src/domain/grants.ts';

const marian = { account: MARIAN, surface: 'voice' as const };
const nadia = { account: NADIA, surface: 'touch' as const };

function held(db: ReturnType<typeof world>, category = 'gardening', note = 'the hedge needs cutting') {
  requestService(db, marian, RIDGEWAY, category as never, note);
  return pendingFor(db, NADIA)[0]!;
}

test('a request the household raised is not blocked by the category list', () => {
  const db = world({ withVisits: false });
  // Window cleaning is deliberately outside the seeded arrangement, and cheap enough
  // that the money limit is not what decides this case.
  const item = held(db, 'window_cleaning', 'the front windows have not been done since spring');
  const r = decideRequest(db, nadia, item.change.id, 'approve');
  assert.equal(r.ok, true);
  assert.equal(r.code, 'booked');
});

test('but the money limit still applies, and sends it back to the household', () => {
  const db = world({ withVisits: false });
  const g = grantsOverHousehold(db, RIDGEWAY.id)[0]!;
  g.spendCapCents = 1_000;
  saveGrant(db, g);
  const item = held(db);
  const r = decideRequest(db, nadia, item.change.id, 'approve');
  assert.equal(r.code, 'awaiting_household');
  assert.equal(r.facts.confirmed, false);
  assert.equal(getVisit(db, item.visit.id)!.status, 'awaiting_subject');
  assert.equal(outbox(db).filter((m) => m.kind === 'needs_household').length, 1);
});

test('declining tells the household and leaves nothing in the diary', () => {
  const db = world({ withVisits: false });
  const item = held(db);
  const r = decideRequest(db, nadia, item.change.id, 'decline');
  assert.equal(r.code, 'declined');
  assert.equal(getVisit(db, item.visit.id)!.status, 'cancelled');
  const msg = outbox(db).find((m) => m.kind === 'request_declined')!;
  assert.match(msg.body, /Nothing is booked/);
  assert.match(msg.body, /Ask again on your Echo/);
});

test('a decision can only be taken once', () => {
  const db = world({ withVisits: false });
  const item = held(db);
  decideRequest(db, nadia, item.change.id, 'approve');
  const again = decideRequest(db, nadia, item.change.id, 'approve');
  assert.equal(again.code, 'already_settled');
});

test('nobody without a live arrangement can decide anything', () => {
  const db = world({ withVisits: false });
  const item = held(db);
  const g = grantsOverHousehold(db, RIDGEWAY.id)[0]!;
  g.status = 'revoked';
  saveGrant(db, g);
  const err = caught<StandbyError>(() => decideRequest(db, nadia, item.change.id, 'approve'));
  assert.equal(err.code, 'no_grant');
  assert.equal(getChange(db, item.change.id)!.status, 'held_for_delegate');
});

test('the ledger records who decided, under which capability, and why', () => {
  const db = world({ withVisits: false });
  const item = held(db);
  decideRequest(db, nadia, item.change.id, 'approve');
  const entry = auditFor(db, RIDGEWAY.id).find((a) => a.action === 'request.approved')!;
  assert.equal(entry.actor, NADIA.id);
  assert.equal(entry.surface, 'touch');
  assert.ok(entry.capability);
  assert.match(entry.reason, /Nadia agreed/);
});

test('pendingFor only shows the delegate the homes they actually stand by for', () => {
  const db = world({ withVisits: false });
  held(db);
  assert.equal(pendingFor(db, NADIA).length, 1);
  assert.equal(pendingFor(db, MARIAN).length, 0);
});
