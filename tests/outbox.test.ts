// The written channel is mandated by Policy Requirement 15 and is also the only route
// On Behalf has to anybody who is not currently speaking to a device. So it is tested
// like a delivery system rather than like a log line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world, MARIAN, NADIA, RIDGEWAY, PROVIDERS } from './helpers.ts';
import { deliver, queue, render } from '../src/domain/outbox.ts';
import { outbox, upcomingVisits } from '../src/domain/store.ts';
import { bookVisit, cancelVisit } from '../src/domain/visits.ts';
import { findSlots } from '../src/domain/availability.ts';
import { addHours, nowIso } from '../src/clock.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'standby-outbox-'));
const nadia = { account: NADIA, surface: 'touch' as const };
const marian = { account: MARIAN, surface: 'voice' as const };

test('a booking writes to both households, and the files can be opened', () => {
  const db = world({ withVisits: false });
  const plumber = PROVIDERS[0]!;
  const slot = findSlots(db, {
    provider: plumber,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: addHours(nowIso(), 48),
    days: 7,
    earliestHour: 9,
    latestHour: 17,
    limit: 1,
  })[0]!;
  bookVisit(db, nadia, {
    house: RIDGEWAY,
    provider: plumber,
    summary: 'the dripping tap',
    startsAt: slot.startsAt,
  });

  const out = dir();
  const report = deliver(db, out);
  assert.equal(report.failed, 0);
  assert.ok(report.sent >= 2);
  const files = readdirSync(out);
  assert.equal(files.length, report.sent);
  const bodies = files.map((f) => readFileSync(join(out, f), 'utf8'));
  assert.ok(bodies.some((b) => b.includes(MARIAN.email)));
  assert.ok(bodies.some((b) => b.includes(NADIA.email)));
});

test('every delivered email says the transport is a mock, in the message itself', () => {
  const db = world();
  const out = dir();
  deliver(db, out);
  for (const f of readdirSync(out).filter((n) => n.endsWith('.eml'))) {
    assert.match(readFileSync(join(out, f), 'utf8'), /X-Standby-Transport: mock/);
  }
});

test('a message that fails is retried and then gives up saying why', () => {
  const db = world({ propose: false, withVisits: false });
  queue(db, {
    channel: 'email',
    to: 'broken@example.invalid',
    subject: 'a test',
    body: 'a test',
    kind: 'test',
  });
  process.env.STANDBY_OUTBOX_FAIL = 'broken';
  try {
    const out = dir();
    let first = deliver(db, out);
    assert.equal(first.sent, 0);
    assert.equal(first.failed, 1);
    assert.match(outbox(db)[0]!.lastError!, /attempt 1/);

    first = deliver(db, out);
    assert.equal(first.failed, 1);
    assert.equal(outbox(db)[0]!.attempts, 2);

    const third = deliver(db, out);
    assert.equal(third.sent, 1, 'the third attempt should get through');
    assert.equal(outbox(db)[0]!.status, 'sent');
    assert.equal(outbox(db)[0]!.lastError, null);
  } finally {
    delete process.env.STANDBY_OUTBOX_FAIL;
  }
});

test('the cancellation message states the charge and never blames anybody', () => {
  const db = world();
  const visit = upcomingVisits(db, RIDGEWAY.id, nowIso())[0]!;
  cancelVisit(db, marian, visit.id, true);
  const msg = outbox(db).find((m) => m.kind === 'visit_cancelled')!;
  assert.match(msg.body, /cancellation charge|no cancellation charge/i);
  assert.match(msg.body, /Marian cancelled it/);
  for (const word in { failed: 1, fault: 1, blame: 1, 'should have': 1 }) {
    assert.ok(!msg.body.toLowerCase().includes(word), `the message says "${word}"`);
  }
});

test('an SMS renders without email headers, and an email with them', () => {
  const db = world({ propose: false, withVisits: false });
  const sms = queue(db, {
    channel: 'sms',
    to: '+15550100001',
    subject: 'ignored on sms',
    body: 'short',
    kind: 'test',
  });
  const email = queue(db, {
    channel: 'email',
    to: 'a@b.invalid',
    subject: 'a subject',
    body: 'long',
    kind: 'test',
  });
  assert.ok(!render(sms).includes('Subject:'));
  assert.match(render(email), /^From: On Behalf/m);
  assert.match(render(email), /^Subject: a subject$/m);
});

test('the identifiers On Behalf keeps off the speaker do appear in writing', () => {
  const db = world();
  const msg = outbox(db).find((m) => m.kind === 'grant_proposed')!;
  assert.equal(msg.channel, 'sms');
  assert.equal(msg.to, MARIAN.sms, 'the phone number is the written channel, not a spoken fact');
});
