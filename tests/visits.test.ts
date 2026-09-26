import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caught, world, MARIAN, NADIA, RIDGEWAY, PROVIDERS } from './helpers.ts';
import {
  bookVisit,
  cancelVisit,
  confirmReschedule,
  requestReschedule,
  requestService,
  acceptPendingVisit,
} from '../src/domain/visits.ts';
import { findSlots } from '../src/domain/availability.ts';
import { auditFor, getVisit, grantsForDelegate, upcomingVisits, visitsIn } from '../src/domain/store.ts';
import { outbox } from '../src/domain/store.ts';
import { addHours, nowIso } from '../src/clock.ts';
import { ScreenError } from '../src/domain/screening.ts';
import { setGrantState } from '../src/domain/grants.ts';

const nadia = { account: NADIA, surface: 'touch' as const };
const marian = { account: MARIAN, surface: 'voice' as const };
const plumber = PROVIDERS[0]!;

function bookableSlot(db: ReturnType<typeof world>) {
  return findSlots(db, {
    provider: plumber,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: addHours(nowIso(), 48),
    days: 14,
    earliestHour: 9,
    latestHour: 17,
    limit: 1,
  })[0]!;
}

test('a booking inside the arrangement goes through and writes to both homes', () => {
  const db = world({ withVisits: false });
  const slot = bookableSlot(db);
  const r = bookVisit(db, nadia, {
    house: RIDGEWAY,
    provider: plumber,
    summary: 'the dripping tap in the kitchen',
    startsAt: slot.startsAt,
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'booked');
  assert.equal(r.facts.reference?.toString().startsWith('SB-'), true);

  const recipients = outbox(db)
    .filter((m) => m.kind === 'booking_confirmed')
    .map((m) => m.to)
    .sort();
  assert.deepEqual(recipients, [MARIAN.email, NADIA.email].sort());

  const ledger = auditFor(db, RIDGEWAY.id).filter((a) => a.action === 'visit.booked');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.capability, 'within_scope');
});

test('a booking outside the arrangement holds, and nothing is confirmed', () => {
  const db = world({ withVisits: false });
  const r = bookVisit(db, nadia, {
    house: RIDGEWAY,
    provider: plumber,
    summary: 'the tap again',
    startsAt: addHours(nowIso(), 3),
  });
  assert.equal(r.code, 'awaiting_household');
  assert.equal(r.facts.confirmed, false);
  assert.equal(
    outbox(db).filter((m) => m.kind === 'booking_confirmed').length,
    0,
    'nothing should be confirmed to anybody yet',
  );
  assert.equal(outbox(db).filter((m) => m.kind === 'needs_household').length, 1);
});

test('the household agreeing turns a held visit into a real one', () => {
  const db = world({ withVisits: false });
  bookVisit(db, nadia, {
    house: RIDGEWAY,
    provider: plumber,
    summary: 'the tap again',
    startsAt: addHours(nowIso(), 3),
  });
  const held = visitsIn(db, RIDGEWAY.id).find((v) => v.status === 'awaiting_subject')!;
  const r = acceptPendingVisit(db, marian, held.id);
  assert.equal(r.code, 'booked');
  assert.equal(getVisit(db, held.id)!.status, 'booked');
  assert.equal(outbox(db).filter((m) => m.kind === 'booking_confirmed').length, 2);
});

test('health content is refused before anything is written', () => {
  const db = world({ withVisits: false });
  const before = visitsIn(db, RIDGEWAY.id).length;
  const err = caught<ScreenError>(() =>
    bookVisit(db, nadia, {
      house: RIDGEWAY,
      provider: plumber,
      summary: 'collect her prescription while he is there',
      startsAt: bookableSlot(db).startsAt,
    }),
  );
  assert.equal(err.code, 'health_content');
  assert.equal(visitsIn(db, RIDGEWAY.id).length, before);
});

test('"move the plumber" resolves to one visit and offers real times', () => {
  const db = world();
  const r = requestReschedule(db, marian, RIDGEWAY, 'move the plumber');
  assert.equal(r.code, 'slots_offered');
  assert.ok((r.options ?? []).length > 0);
  assert.match(String(r.facts.matchedOn), /plumb/);
});

test('an ambiguous phrase offers the candidates rather than guessing', () => {
  const db = world();
  const r = requestReschedule(db, marian, RIDGEWAY, 'move it');
  assert.equal(r.code, 'several_matched');
  assert.equal((r.options ?? []).length, 2);
});

test('a phrase matching nothing changes nothing', () => {
  const db = world();
  const r = requestReschedule(db, marian, RIDGEWAY, 'move the piano tuner');
  assert.equal(r.code, 'nothing_matched');
  assert.equal(
    auditFor(db, RIDGEWAY.id).filter((a) => a.action === 'change.requested').length,
    0,
  );
});

test('only a time On Behalf offered can be confirmed', () => {
  const db = world();
  const offered = requestReschedule(db, marian, RIDGEWAY, 'move the plumber');
  const changeId = String(offered.facts.changeId);
  const invented = confirmReschedule(db, marian, changeId, '2031-01-01T10:00:00.000Z');
  assert.equal(invented.ok, false);
  assert.equal(invented.code, 'not_offered');

  const real = confirmReschedule(db, marian, changeId, String(offered.options![0]!.startsAt));
  assert.equal(real.code, 'moved');
  assert.equal(real.facts.writtenConfirmationSent, true);
  assert.equal(outbox(db).filter((m) => m.kind === 'visit_moved').length, 2);
});

test('a confirmed change cannot be confirmed twice', () => {
  const db = world();
  const offered = requestReschedule(db, marian, RIDGEWAY, 'move the plumber');
  const slot = String(offered.options![0]!.startsAt);
  confirmReschedule(db, marian, String(offered.facts.changeId), slot);
  const again = confirmReschedule(db, marian, String(offered.facts.changeId), slot);
  assert.equal(again.code, 'already_settled');
});

test('cancelling reads the policy back first and cancels nothing on that turn', () => {
  const db = world();
  const visit = upcomingVisits(db, RIDGEWAY.id, nowIso())[0]!;
  const first = cancelVisit(db, marian, visit.id, false);
  assert.equal(first.code, 'confirm_cancellation');
  assert.ok(String(first.facts.cancellationPolicy).length > 10);
  assert.ok(String(first.facts.cancellationCost).endsWith('dollars'));
  assert.equal(getVisit(db, visit.id)!.status, 'booked');

  const second = cancelVisit(db, marian, visit.id, true);
  assert.equal(second.code, 'cancelled');
  assert.equal(getVisit(db, visit.id)!.status, 'cancelled');
});

test('the delegate cannot cancel when the arrangement did not grant cancelling', () => {
  const db = world();
  db.prepare(`UPDATE grant_row SET mayCancel = 0`).run();
  const visit = upcomingVisits(db, RIDGEWAY.id, nowIso())[0]!;
  const r = cancelVisit(db, nadia, visit.id, true);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'action_not_granted');
  assert.equal(getVisit(db, visit.id)!.status, 'booked');
});

test('the household asking for work passes it on rather than booking it', () => {
  const db = world({ withVisits: false });
  const r = requestService(db, marian, RIDGEWAY, 'gutters', 'the gutter is overflowing');
  assert.equal(r.code, 'passed_on');
  assert.equal(r.facts.booked, false);
  assert.equal(r.facts.passedTo, 'Nadia');
  assert.equal(upcomingVisits(db, RIDGEWAY.id, nowIso()).length, 0, 'nothing is in the diary');
  assert.equal(outbox(db).filter((m) => m.kind === 'change_held').length, 1);
});

test('an arrangement revoked between the two turns stops the move', () => {
  // `requestReschedule` authorised and `confirmReschedule` did not, and the two turns
  // are minutes apart. Pausing an arrangement from your own speaker is the control this
  // product sells, so it has to bite on the turn that writes, not only the turn that
  // asks. The old code moved the visit and then wrote an audit row marked `within_scope`.
  const db = world();
  const theVisit = () => visitsIn(db, RIDGEWAY.id).find((v) => v.providerId === plumber.id)!;
  const before = theVisit().startsAt;

  const offered = requestReschedule(db, nadia, RIDGEWAY, 'move the plumber');
  const slot = String(offered.options![0]!.startsAt);

  const grant = grantsForDelegate(db, NADIA.id)[0]!;
  setGrantState(db, MARIAN, grant.id, 'revoked');

  const after = confirmReschedule(db, nadia, String(offered.facts.changeId), slot);
  assert.equal(after.ok, false, 'a revoked delegate must not complete the move');
  assert.equal(theVisit().startsAt, before, 'nothing moved');
  assert.equal(
    auditFor(db, RIDGEWAY.id).filter((a) => a.action === 'visit.moved').length,
    0,
    'and the ledger does not claim it was authorised',
  );
});

test('the household itself can still finish a move it started', () => {
  const db = world();
  const offered = requestReschedule(db, marian, RIDGEWAY, 'move the plumber');
  const r = confirmReschedule(db, marian, String(offered.facts.changeId), String(offered.options![0]!.startsAt));
  assert.equal(r.code, 'moved');
});
