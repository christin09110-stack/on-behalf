import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, RIDGEWAY, CALDER, PROVIDERS } from './helpers.ts';
import { findSlots, slotsOnDay, weekdayIndex } from '../src/domain/availability.ts';
import { localHour, addDays, nowIso, addHours } from '../src/clock.ts';
import { upcomingVisits, saveVisit, getVisit } from '../src/domain/store.ts';

const plumber = PROVIDERS[0]!;

test('the same provider offers the same slots on the same day, on every run', () => {
  const day = addDays(nowIso(), 3);
  const a = slotsOnDay(plumber, day, RIDGEWAY.timezone).map((s) => s.startsAt);
  const b = slotsOnDay(plumber, day, RIDGEWAY.timezone).map((s) => s.startsAt);
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
});

test('slots fall inside working hours, judged in the household\'s own timezone', () => {
  for (let d = 1; d < 8; d++) {
    for (const s of slotsOnDay(plumber, addDays(nowIso(), d), RIDGEWAY.timezone)) {
      const h = localHour(s.startsAt, RIDGEWAY.timezone);
      assert.ok(h >= 8 && h < 18, `${s.startsAt} is ${h} local`);
    }
  }
});

test('the same instant is a different local hour in the two households', () => {
  const day = addDays(nowIso(), 3);
  const east = slotsOnDay(plumber, day, RIDGEWAY.timezone)[0]!;
  assert.notEqual(
    localHour(east.startsAt, RIDGEWAY.timezone),
    localHour(east.startsAt, CALDER.timezone),
  );
});

test('nobody is offered a Sunday', () => {
  for (let d = 0; d < 14; d++) {
    const day = addDays(nowIso(), d);
    if (weekdayIndex(day, RIDGEWAY.timezone) !== 0) continue;
    assert.equal(slotsOnDay(plumber, day, RIDGEWAY.timezone).length, 0);
  }
});

test('a slot the household already has something in is not offered again', () => {
  const db = world({ withVisits: false });
  const free = findSlots(db, {
    provider: plumber,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: addHours(nowIso(), 48),
    days: 7,
    limit: 2,
  });
  assert.ok(free.length >= 1);
  saveVisit(db, {
    id: 'visit_block',
    householdId: RIDGEWAY.id,
    providerId: plumber.id,
    category: 'plumbing',
    summary: 'something else already',
    startsAt: free[0]!.startsAt,
    endsAt: free[0]!.endsAt,
    status: 'booked',
    priceCents: 1,
    reference: 'SB-TEST',
    arrangedBy: 'acct_marian',
    arrangedAt: nowIso(),
    previousStartsAt: null,
  });
  const after = findSlots(db, {
    provider: plumber,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: addHours(nowIso(), 48),
    days: 7,
    limit: 2,
  });
  assert.ok(!after.some((s) => s.startsAt === free[0]!.startsAt));
});

test('a visit nobody has agreed to yet still blocks its slot', () => {
  const db = world({ withVisits: false });
  const free = findSlots(db, {
    provider: plumber,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: addHours(nowIso(), 48),
    days: 7,
    limit: 1,
  })[0]!;
  saveVisit(db, {
    id: 'visit_proposed',
    householdId: RIDGEWAY.id,
    providerId: plumber.id,
    category: 'plumbing',
    summary: 'asked for, not agreed',
    startsAt: free.startsAt,
    endsAt: free.endsAt,
    status: 'proposed',
    priceCents: 1,
    reference: 'SB-TEST',
    arrangedBy: 'acct_marian',
    arrangedAt: nowIso(),
    previousStartsAt: null,
  });
  const after = findSlots(db, {
    provider: plumber,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: addHours(nowIso(), 48),
    days: 7,
    limit: 3,
  });
  assert.ok(!after.some((s) => s.startsAt === free.startsAt));
  // A proposed visit is not in the diary, though, so it must not be read back as one.
  assert.ok(!upcomingVisits(db, RIDGEWAY.id, nowIso()).some((v) => v.id === 'visit_proposed'));
  assert.equal(getVisit(db, 'visit_proposed')!.status, 'proposed');
});

test('asking for a weekday returns only that weekday', () => {
  const db = world({ withVisits: false });
  const thursday = 4;
  const slots = findSlots(db, {
    provider: plumber,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: nowIso(),
    days: 21,
    onlyWeekday: thursday,
    limit: 3,
  });
  assert.ok(slots.length > 0);
  for (const s of slots) {
    assert.equal(weekdayIndex(s.startsAt, RIDGEWAY.timezone), thursday);
  }
});

test('agreed hours narrow the offer rather than widening it', () => {
  const db = world({ withVisits: false });
  const narrow = findSlots(db, {
    provider: plumber,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: nowIso(),
    days: 14,
    earliestHour: 10,
    latestHour: 12,
    limit: 5,
  });
  for (const s of narrow) {
    const h = localHour(s.startsAt, RIDGEWAY.timezone);
    assert.ok(h >= 10 && h < 12, `${h} is outside 10 to 12`);
  }
});
