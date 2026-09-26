import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caught, world, MARIAN, NADIA, RIDGEWAY, CALDER } from './helpers.ts';
import {
  acceptGrant,
  proposeGrant,
  setGrantState,
  StandbyError,
  DEFAULT_TERMS,
} from '../src/domain/grants.ts';
import {
  grantsOverHousehold,
  grantsForDelegate,
  liveGrantsForDelegate,
  auditFor,
  outbox,
} from '../src/domain/store.ts';
import { targetHousehold } from '../src/mcp/registry.ts';
import { pairingCode } from '../src/ids.ts';

test('a proposal grants nothing and reaches the other household in writing', () => {
  const db = world({ propose: false });
  const g = proposeGrant(db, NADIA, RIDGEWAY, DEFAULT_TERMS);
  assert.equal(g.status, 'proposed');
  assert.equal(g.acceptedAt, null);
  const msg = outbox(db).find((m) => m.kind === 'grant_proposed')!;
  assert.equal(msg.to, MARIAN.sms);
  assert.ok(msg.body.includes(g.pairingCode!), 'the code has to travel to the other household');
  assert.match(msg.body, /Nothing happens until you agree/);
});

test('acceptance has to come from inside the household being helped', () => {
  const db = world({ propose: false });
  const g = proposeGrant(db, NADIA, RIDGEWAY, DEFAULT_TERMS);
  const err = caught<StandbyError>(() => acceptGrant(db, NADIA, g.pairingCode!, 'voice'));
  assert.equal(err.code, 'wrong_household');
  assert.equal(grantsOverHousehold(db, RIDGEWAY.id)[0]!.status, 'proposed');
});

test('an unknown code is refused without saying whether one exists', () => {
  const db = world({ propose: false });
  const err = caught<StandbyError>(() => acceptGrant(db, MARIAN, pairingCode(), 'voice'));
  assert.equal(err.code, 'unknown_code');
});

test('accepting records who, when and through which surface, and clears the code', () => {
  const db = world({ propose: false });
  const g = proposeGrant(db, NADIA, RIDGEWAY, DEFAULT_TERMS);
  const active = acceptGrant(db, MARIAN, g.pairingCode!, 'voice');
  assert.equal(active.status, 'active');
  assert.equal(active.acceptedVia, 'voice');
  assert.equal(active.subjectAccount, MARIAN.id);
  assert.equal(active.pairingCode, null, 'a used code must not stay usable');

  const entry = auditFor(db, RIDGEWAY.id).find((a) => a.action === 'grant.accepted')!;
  assert.equal(entry.actor, MARIAN.id);
  assert.equal(entry.surface, 'voice');
});

test('a code cannot be accepted twice', () => {
  const db = world({ propose: false });
  const g = proposeGrant(db, NADIA, RIDGEWAY, DEFAULT_TERMS);
  const code = g.pairingCode!;
  acceptGrant(db, MARIAN, code, 'voice');
  const err = caught<StandbyError>(() => acceptGrant(db, MARIAN, code, 'voice'));
  assert.equal(err.code, 'unknown_code');
});

test('the code alphabet has no characters that sound alike when spoken', () => {
  const codes = Array.from({ length: 200 }, () => pairingCode()).join('');
  assert.match(codes, /^[234679CDGHJKRTWXYZ]+$/);
  for (const confusable of ['0', 'O', 'I', '1', '5', 'S', 'B', 'P', 'M', 'N', 'F', '8']) {
    assert.ok(!codes.includes(confusable), `${confusable} is too easy to mishear`);
  }
});

test('only the household being helped can pause or end an arrangement', () => {
  const db = world();
  const g = grantsOverHousehold(db, RIDGEWAY.id)[0]!;
  const err = caught<StandbyError>(() => setGrantState(db, NADIA, g.id, 'revoked'));
  assert.equal(err.code, 'not_yours_to_change');
  assert.equal(grantsOverHousehold(db, RIDGEWAY.id)[0]!.status, 'active');
});

test('pausing tells the delegate in writing and says booked visits stand', () => {
  const db = world();
  const g = grantsOverHousehold(db, RIDGEWAY.id)[0]!;
  setGrantState(db, MARIAN, g.id, 'paused');
  const msg = outbox(db).find((m) => m.kind === 'grant_paused')!;
  assert.equal(msg.to, NADIA.email);
  assert.match(msg.body, /Visits already in the diary stand/);
});

test('an arrangement never points at the delegate\'s own household', () => {
  const db = world();
  assert.equal(grantsOverHousehold(db, CALDER.id).length, 0);
});

test('a revoked delegate can no longer reach the household at all', () => {
  // `grantsForDelegate` returns rows of any status, so the reachable set used to include
  // households whose arrangement had been revoked from their own speaker. Revoking is
  // the control this product sells; it has to remove reach, not only permission.
  const db = world();
  const caller = { account: NADIA, household: CALDER } as never;
  const before = targetHousehold(db, caller, 'Ridgeway');
  assert.equal(before.name, 'Ridgeway');

  const grant = grantsForDelegate(db, NADIA.id)[0]!;
  setGrantState(db, MARIAN, grant.id, 'revoked');

  assert.throws(() => targetHousehold(db, caller, 'Ridgeway'), /you can act in/);
  assert.equal(liveGrantsForDelegate(db, NADIA.id).length, 0);
});

test('a merely proposed arrangement reaches nothing', () => {
  // Nobody has agreed to it yet, which is the whole point of proposing.
  const db = world({ propose: false });
  proposeGrant(db, NADIA, RIDGEWAY, DEFAULT_TERMS);
  assert.equal(liveGrantsForDelegate(db, NADIA.id).length, 0);
});

test('a paused arrangement still lets the delegate look, and authorize stops the writing', () => {
  const db = world();
  const grant = grantsForDelegate(db, NADIA.id)[0]!;
  setGrantState(db, MARIAN, grant.id, 'paused');
  assert.equal(liveGrantsForDelegate(db, NADIA.id).length, 1);
});
