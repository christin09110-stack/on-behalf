import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../src/domain/capability.ts';
import type { Grant } from '../src/types.ts';
import { MARIAN, NADIA, RIDGEWAY } from './helpers.ts';
import { addDays, addHours, nowIso } from '../src/clock.ts';

const baseGrant = (over: Partial<Grant> = {}): Grant => ({
  id: 'grant_test',
  delegateAccount: NADIA.id,
  subjectHousehold: RIDGEWAY.id,
  subjectAccount: MARIAN.id,
  status: 'active',
  categories: ['plumbing', 'heating'],
  spendCapCents: 20_000,
  noticeHours: 24,
  earliestHour: 9,
  latestHour: 17,
  mayBook: true,
  mayReschedule: true,
  mayCancel: false,
  proposedAt: nowIso(),
  acceptedAt: nowIso(),
  acceptedVia: 'voice',
  expiresAt: addDays(nowIso(), 90),
  pairingCode: null,
  revokedAt: null,
  revokedBy: null,
  ...over,
});

/** A time that is inside the notice window and inside agreed hours. */
const goodTime = () => {
  const d = new Date(Date.now() + 5 * 86_400_000);
  d.setUTCHours(15, 0, 0, 0); // 11am in New York
  return d.toISOString();
};

test('the household is never locked out of its own home, even with no arrangement', () => {
  const d = authorize({
    actor: MARIAN,
    targetHousehold: RIDGEWAY,
    action: 'cancel',
    category: 'chimney',
    priceCents: 900_000,
    startsAt: addHours(nowIso(), 1),
    grant: null,
  });
  assert.equal(d.verdict, 'allow');
  assert.equal(d.code, 'own_household');
});

test('a delegate with no arrangement is refused', () => {
  const d = authorize({
    actor: NADIA,
    targetHousehold: RIDGEWAY,
    action: 'book',
    grant: null,
  });
  assert.equal(d.verdict, 'deny');
  assert.equal(d.code, 'no_grant');
  assert.match(d.reason, /has agreed/);
});

test('an arrangement that has not been accepted grants nothing', () => {
  const d = authorize({
    actor: NADIA,
    targetHousehold: RIDGEWAY,
    action: 'book',
    grant: baseGrant({ status: 'proposed' }),
  });
  assert.equal(d.code, 'grant_unaccepted');
  assert.equal(d.verdict, 'deny');
});

test('paused, revoked and expired each refuse, and each say something different', () => {
  const codes = (['paused', 'revoked'] as const).map(
    (status) =>
      authorize({
        actor: NADIA,
        targetHousehold: RIDGEWAY,
        action: 'book',
        grant: baseGrant({ status }),
      }).code,
  );
  const expired = authorize({
    actor: NADIA,
    targetHousehold: RIDGEWAY,
    action: 'book',
    grant: baseGrant({ expiresAt: addDays(nowIso(), -1) }),
  });
  assert.deepEqual(codes, ['grant_paused', 'grant_revoked']);
  assert.equal(expired.code, 'grant_expired');
});

test('reading is allowed where acting is not', () => {
  const grant = baseGrant({ mayBook: false, mayReschedule: false, mayCancel: false });
  assert.equal(authorize({ actor: NADIA, targetHousehold: RIDGEWAY, action: 'read', grant }).verdict, 'allow');
  assert.equal(
    authorize({ actor: NADIA, targetHousehold: RIDGEWAY, action: 'book', grant }).code,
    'action_not_granted',
  );
});

test('cancelling is refused when the arrangement did not grant it', () => {
  const d = authorize({
    actor: NADIA,
    targetHousehold: RIDGEWAY,
    action: 'cancel',
    category: 'plumbing',
    grant: baseGrant(),
  });
  assert.equal(d.code, 'action_not_granted');
});

test('a category outside the arrangement is refused by name', () => {
  const d = authorize({
    actor: NADIA,
    targetHousehold: RIDGEWAY,
    action: 'book',
    category: 'chimney',
    grant: baseGrant(),
  });
  assert.equal(d.code, 'category_not_in_scope');
  assert.match(d.reason, /Chimney work/);
});

test('money over the limit is held for the household, not refused and not spent', () => {
  const d = authorize({
    actor: NADIA,
    targetHousehold: RIDGEWAY,
    action: 'book',
    category: 'plumbing',
    priceCents: 30_000,
    startsAt: goodTime(),
    grant: baseGrant(),
  });
  assert.equal(d.verdict, 'hold');
  assert.equal(d.code, 'over_spend_cap');
  assert.equal(d.unblockedBy, 'subject_consent');
});

test('a visit inside the notice window waits for somebody at home', () => {
  const d = authorize({
    actor: NADIA,
    targetHousehold: RIDGEWAY,
    action: 'book',
    category: 'plumbing',
    priceCents: 9_000,
    startsAt: addHours(nowIso(), 3),
    grant: baseGrant(),
  });
  assert.equal(d.verdict, 'hold');
  assert.equal(d.code, 'inside_notice_window');
});

test('hours are judged in the household\'s own timezone, not the delegate\'s', () => {
  // 13:00 UTC is 9am in New York, which is inside the agreed hours, and 6am in
  // Los Angeles, which is not. Ridgeway is the household, so this is allowed.
  const d = new Date(Date.now() + 5 * 86_400_000);
  d.setUTCHours(13, 0, 0, 0);
  const inside = authorize({
    actor: NADIA,
    targetHousehold: RIDGEWAY,
    action: 'book',
    category: 'plumbing',
    priceCents: 9_000,
    startsAt: d.toISOString(),
    grant: baseGrant(),
  });
  assert.equal(inside.verdict, 'allow');

  d.setUTCHours(11, 0, 0, 0); // 7am in New York
  const outside = authorize({
    actor: NADIA,
    targetHousehold: RIDGEWAY,
    action: 'book',
    category: 'plumbing',
    priceCents: 9_000,
    startsAt: d.toISOString(),
    grant: baseGrant(),
  });
  assert.equal(outside.code, 'outside_agreed_hours');
  assert.equal(outside.unblockedBy, 'subject_consent');
});

test('an arrangement cannot be pointed at a household it was not made for', () => {
  const d = authorize({
    actor: NADIA,
    targetHousehold: { ...RIDGEWAY, id: 'house_elsewhere' },
    action: 'book',
    grant: baseGrant(),
  });
  assert.equal(d.code, 'grant_mismatch');
});

test('every decision carries a reason written for a person', () => {
  for (const status of ['proposed', 'paused', 'revoked'] as const) {
    const d = authorize({
      actor: NADIA,
      targetHousehold: RIDGEWAY,
      action: 'book',
      grant: baseGrant({ status }),
    });
    assert.ok(d.reason.length > 20, `${status} reason too short`);
    assert.ok(/[.!]$/.test(d.reason), `${status} reason is not a sentence`);
  }
});
