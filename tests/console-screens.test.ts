// Four things the screen audit found that are not about authorisation: a clash nobody
// was told about, a table that ran off a phone, a machine-shaped date in a page of
// careful English, and a 404 that looked like being signed out.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, MARIAN, NADIA, RIDGEWAY, PROVIDERS } from './helpers.ts';
import { startConsole } from '../src/web/server.ts';
import { mintPair } from '../src/mcp/auth.ts';
import { bookVisit, clashingVisits } from '../src/domain/visits.ts';
import { findSlots } from '../src/domain/availability.ts';
import { addHours, nowIso } from '../src/clock.ts';
import type { Db } from '../src/db.ts';

let db: Db;
let http: ReturnType<typeof startConsole>;
let port: number;
const cookies = new Map<string, string>();

before(async () => {
  db = world();
  port = 5500 + Math.floor(Math.random() * 300);
  http = startConsole(port, db);
  await new Promise((r) => http.once('listening', r));
  for (const a of [MARIAN, NADIA]) cookies.set(a.id, `standby=${mintPair(db, a.id).access_token}`);
});

after(() => {
  http.close();
  db.close();
});

const get = (path: string, account: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { cookie: cookies.get(account)! },
    redirect: 'manual',
  });

/** Two trades into one hour, the way the console's own forms produced three. */
function bookTwoIntoOneHour(): { at: string; second: ReturnType<typeof bookVisit> } {
  const plumber = PROVIDERS.find((p) => p.category === 'plumbing')!;
  const gardener = PROVIDERS.find((p) => p.category === 'gardening')!;
  const slot = findSlots(db, {
    provider: plumber,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: nowIso(),
    days: 7,
    limit: 1,
    earliestHour: 9,
    latestHour: 17,
  })[0]!;
  const nadia = { account: NADIA, surface: 'touch' as const };
  bookVisit(db, nadia, {
    house: RIDGEWAY,
    provider: plumber,
    summary: 'the dripping tap',
    startsAt: slot.startsAt,
  });
  // The second booking names the same hour, which is what happens when the delegate
  // picks a time on one trade's page and then a time on the next trade's page.
  const second = bookVisit(db, nadia, {
    house: RIDGEWAY,
    provider: gardener,
    summary: 'the hedge at the front',
    startsAt: slot.startsAt,
  });
  return { at: slot.startsAt, second };
}

test('booking a second trade into an hour that is already taken says so', async () => {
  const { second } = bookTwoIntoOneHour();
  assert.equal(second.ok, true, 'it still goes through: two at once is the household\'s call');
  assert.match(
    String(second.facts?.clash ?? ''),
    /is already coming at .*Two people will be at the door together\./,
    'nothing was said about the clash',
  );
});

test('the diary marks both visits afterwards, where the household actually looks', async () => {
  const body = await (await get(`/home?household=${RIDGEWAY.id}`, NADIA.id)).text();
  assert.equal((body.match(/two at once/g) ?? []).length, 2, 'both sides of the clash are marked');
  assert.match(body, /two people will be at the door together/i);
});

test('the ledger records the clash, so it is in the account of what was done', async () => {
  const body = await (await get(`/ledger?household=${RIDGEWAY.id}`, NADIA.id)).text();
  assert.match(body, /Two people will be at the door together\./);
});

test('a visit that is alone in its hour clashes with nothing', () => {
  // Three weeks out, well past anything the seed or the tests above put in the diary.
  const alone = addHours(nowIso(), 24 * 21);
  assert.deepEqual(clashingVisits(db, RIDGEWAY.id, alone, addHours(alone, 1)), []);
});

test('an overlap that is not an exact match still counts, which is how three arrived at once', () => {
  // `findSlots` drops a slot whose start time equals one already in the diary. That is
  // not the same question: a visit runs an hour, and a slot half an hour into it is free
  // by that test and occupied in the house. This is the check the booking path now makes.
  const { at } = bookTwoIntoOneHour();
  const halfway = addHours(at, 0.5);
  assert.ok(
    clashingVisits(db, RIDGEWAY.id, halfway, addHours(halfway, 1)).length >= 1,
    'an overlapping hour reported no clash',
  );
});

test('every table cell carries its column name, so a phone can stack it', async () => {
  const body = await (await get(`/ledger?household=${RIDGEWAY.id}`, NADIA.id)).text();
  for (const column of ['When', 'Who', 'What', 'Why', 'How']) {
    assert.ok(body.includes(`data-label="${column}"`), `the ${column} column has no label`);
  }
  // The column that went over the right edge at 390px was How, which is the pills.
  assert.match(body, /data-label="How">.*class="tag/);
});

test('the ledger states its times the way the rest of the app does', async () => {
  const body = await (await get(`/ledger?household=${RIDGEWAY.id}`, NADIA.id)).text();
  assert.doesNotMatch(body, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, 'a machine-shaped date is on screen');
  assert.match(body, /data-label="When"><span class="num">[A-Z][a-z]+ \d{1,2} at \d{1,2}:\d{2}/);
});

test('money on screen drops cents it does not have', async () => {
  const body = await (await get(`/home?household=${RIDGEWAY.id}`, NADIA.id)).text();
  assert.doesNotMatch(body, /\d\.00 dollars/, 'a price still reads as a raw decimal');
  assert.match(body, /\d+ dollars/);
});

test('an unknown address says so, rather than handing back the Accounts page', async () => {
  const res = await get('/nope', NADIA.id);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /class="flash bad">On Behalf has no page at \/nope\./, 'no error element at all');
  assert.match(body, /There is no page at that address/);
  assert.match(body, /<title>Not found · On Behalf<\/title>/);
  // It used to offer to sign you in as the other account while you were signed in.
  assert.doesNotMatch(body, /action="\/link"/);
});
