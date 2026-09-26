// Authorisation, which on this product is not a hardening detail.
//
// Standby is one household administering another household's affairs. "Who may reach
// this home, and to do what" is the domain model, so a hole in it is the premise failing
// rather than a security finding beside it. A review found three, and every test below
// was written by reproducing one at a terminal first and keeping the reproduction.
//
//   1. `POST /link` minted a bearer token for any account id in a form field. Every
//      account id is printed on the unauthenticated front page.
//   2. `authorize(` appeared zero times anywhere under `src/mcp/`. The capability engine
//      was real and sat on four write paths inside `src/domain/`; every read tool and
//      every tool taking a record id reached the database without it.
//   3. `grantsForDelegate` selects rows of any status, and the delegate tools read it, so
//      a revoked or never-accepted arrangement still named the other household and the
//      date of its next visit.
//
// The third has a fourth hiding inside it that the review did not name: `status` is set
// by a person, and nothing flips it to `expired` when the clock passes `expiresAt`. An
// arrangement accepted for a year read as `active` for ever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caught, world, MARIAN, NADIA, RIDGEWAY, CALDER } from './helpers.ts';
import { ALL_TOOLS, toolByName } from '../src/mcp/tools.ts';
import { invokeTool } from '../src/mcp/registry.ts';
import { authorizeCall } from '../src/mcp/authorize.ts';
import type { Caller } from '../src/mcp/auth.ts';
import { StandbyError, setGrantState } from '../src/domain/grants.ts';
import {
  getHousehold,
  grantsForDelegate,
  liveGrantsForDelegate,
  saveGrant,
  upcomingVisits,
} from '../src/domain/store.ts';
import { startConsole } from '../src/web/server.ts';
import { nowIso } from '../src/clock.ts';
import type { Db } from '../src/db.ts';

const callerFor = (db: Db, account: typeof NADIA): Caller => ({
  account,
  household: getHousehold(db, account.householdId)!,
  surface: 'voice',
});

const run = (db: Db, caller: Caller, name: string, args: Record<string, unknown> = {}) =>
  invokeTool(db, caller, toolByName(name)!, args);

// ---------------------------------------------------------------------------
// Hole 1. Reproduced with:
//   curl -sS -X POST localhost:PORT/link -d 'account=acct_marian'
// which answered 303 with `set-cookie: standby=<token>` and that token read Ridgeway's
// ledger. The console is an OAuth client standing in for Amazon's consent screen, and an
// unauthenticated form cannot be the thing that decides who you are.
// ---------------------------------------------------------------------------

async function console_(db: Db) {
  const http = startConsole(0, db);
  await new Promise((r) => http.once('listening', r));
  const port = (http.address() as { port: number }).port;
  return { http, port };
}

const post = (port: number, path: string, fields: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });

test('POST /link does not mint a token for an account id somebody typed', async () => {
  const db = world();
  const { http, port } = await console_(db);
  try {
    const res = await post(port, '/link', { account: MARIAN.id });
    assert.equal(
      res.headers.get('set-cookie'),
      null,
      'a form field named an account and got a bearer token for it',
    );
    assert.match(res.headers.get('location') ?? '', /kind=bad/);
  } finally {
    http.close();
    db.close();
  }
});

test('and a wrong sign-in code is refused the same way as a missing one', async () => {
  const db = world();
  const { http, port } = await console_(db);
  try {
    for (const code of ['', 'guess', 'AAAAAAAA']) {
      const res = await post(port, '/link', { account: MARIAN.id, code });
      assert.equal(res.headers.get('set-cookie'), null, `code ${JSON.stringify(code)} linked`);
    }
  } finally {
    http.close();
    db.close();
  }
});

test('the console still signs in with the code it printed, so the fix is not a wall', async () => {
  // Non-vacuity for the two above: they assert an absence, and this proves the path they
  // are guarding exists and works. Without it, deleting the whole route passes them both.
  process.env.STANDBY_CONSOLE_CODE = 'test-console-code';
  const { CONSOLE_CODE } = await import('../src/web/server.ts');
  const db = world();
  const { http, port } = await console_(db);
  try {
    const res = await post(port, '/link', { account: MARIAN.id, code: CONSOLE_CODE });
    assert.match(res.headers.get('set-cookie') ?? '', /^standby=[^;]{20,}/);
    const token = /standby=([^;]+)/.exec(res.headers.get('set-cookie')!)![1]!;
    const page = await fetch(`http://127.0.0.1:${port}/ledger`, {
      headers: { cookie: `standby=${token}` },
      redirect: 'manual',
    });
    assert.equal(page.status, 200);
  } finally {
    http.close();
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Hole 3, and the expiry hiding inside it.
// ---------------------------------------------------------------------------

test('a revoked arrangement stops naming the other household at all', () => {
  const db = world();
  const nadia = callerFor(db, NADIA);
  const before = run(db, nadia, 'list_on_behalf_households');
  assert.equal(before.rows?.length, 1, 'the fixture has to start with something to lose');
  assert.equal(before.rows![0]!.household, 'Ridgeway');

  setGrantState(db, MARIAN, grantsForDelegate(db, NADIA.id)[0]!.id, 'revoked');

  const after = run(db, nadia, 'list_on_behalf_households');
  assert.equal(after.code, 'no_arrangements');
  assert.deepEqual(after.rows, [], 'a revoked arrangement still listed the household');
  // The row carried the name, the terms and the date of the next visit. Assert on the
  // rendered values rather than the row count, so a row of empty strings does not pass.
  const rendered = JSON.stringify(after);
  assert.ok(!rendered.includes('Ridgeway'), 'the household is still named after revocation');
  const next = upcomingVisits(db, RIDGEWAY.id, nowIso())[0]!;
  assert.ok(
    !rendered.includes(next.startsAt.slice(0, 10)),
    'the date of the next visit survived revocation',
  );
});

test('an arrangement nobody has accepted yet is not listed either', () => {
  const db = world({ accept: false });
  const nadia = callerFor(db, NADIA);
  assert.equal(grantsForDelegate(db, NADIA.id).length, 1, 'a proposed row exists to be filtered');
  const r = run(db, nadia, 'list_on_behalf_households');
  assert.equal(r.code, 'no_arrangements');
  assert.ok(!JSON.stringify(r).includes('Ridgeway'));
});

test('an arrangement that has run out stops reaching, even while its status says active', () => {
  const db = world();
  const nadia = callerFor(db, NADIA);
  const grant = grantsForDelegate(db, NADIA.id)[0]!;
  assert.equal(grant.status, 'active', 'nothing flips status to expired, which is the point');

  grant.expiresAt = '2020-01-01T00:00:00.000Z';
  saveGrant(db, grant);

  assert.deepEqual(liveGrantsForDelegate(db, NADIA.id), []);
  for (const tool of ['get_visits', 'what_changed', 'latest_brief', 'what_is_waiting']) {
    const err = caught<StandbyError>(() => run(db, nadia, tool, { household: 'Ridgeway' }));
    assert.equal(err.name, 'StandbyError', `${tool} answered an expired arrangement`);
  }
});

// ---------------------------------------------------------------------------
// Hole 2. One gate, and every tool behind it.
// ---------------------------------------------------------------------------

test('every tool declares which household its call is about', () => {
  for (const tool of ALL_TOOLS) {
    assert.equal(typeof tool.subject, 'function', `${tool.name} has no subject resolver`);
  }
  assert.ok(ALL_TOOLS.length >= 20, `only ${ALL_TOOLS.length} tools, so the walk found nothing`);
});

test('neither surface can run a tool around the gate', () => {
  // `invokeTool` is the only thing that calls `authorizeCall`. A file that calls
  // `tool.run` itself has quietly opened a second door, which is exactly how the gate
  // came to be missing in the first place.
  for (const file of ['src/mcp/server.ts', 'src/web/views.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(src.includes('invokeTool('), `${file} does not go through invokeTool`);
    assert.ok(!/\btool\.run\s*\(/.test(src), `${file} calls tool.run directly, around the gate`);
  }
  // Non-vacuity: the string being searched for has to be findable somewhere, or the
  // assertion above passes against a typo.
  const registry = readFileSync(new URL('../src/mcp/registry.ts', import.meta.url), 'utf8');
  assert.ok(/tool\.run\(/.test(registry), 'invokeTool no longer runs the tool');
  assert.ok(/authorizeCall\(/.test(registry), 'invokeTool no longer authorises');
});

/**
 * The tools that can name a household other than the caller's, and the arguments that
 * make them do it. Everything else acts on the caller's own home, and is listed below
 * with the reason, so the two lists together account for every tool in the registry.
 */
function reachesAnotherHome(db: Db): Array<[string, Record<string, unknown>]> {
  const visit = upcomingVisits(db, RIDGEWAY.id, nowIso())[0]!;
  const nadia = callerFor(db, NADIA);
  // A live change request at Ridgeway, made while the arrangement was still good, so the
  // record-id tools have something real to be refused about.
  const offered = run(db, nadia, 'request_change', { household: 'Ridgeway', phrase: 'move the plumber' });
  const changeId = String(offered.facts!.changeId);
  return [
    ['get_visits', { household: 'Ridgeway' }],
    ['who_arranged', { household: 'Ridgeway', visitId: visit.id }],
    ['request_change', { household: 'Ridgeway', phrase: 'move the plumber' }],
    ['confirm_change', { changeId, startsAt: String(offered.options![0]!.startsAt) }],
    ['start_cancellation', { visitId: visit.id }],
    ['confirm_cancellation', { visitId: visit.id }],
    ['what_is_waiting', { household: 'Ridgeway' }],
    ['agree_to_visit', { visitId: visit.id }],
    ['ask_for_service', { household: 'Ridgeway', category: 'gardening', note: 'the hedge' }],
    ['what_changed', { household: 'Ridgeway' }],
    ['find_provider', { household: 'Ridgeway', category: 'plumbing' }],
    ['book_visit', { household: 'Ridgeway', providerId: 'prov_halloran', startsAt: visit.startsAt, summary: 'a tap' }],
    ['latest_brief', { household: 'Ridgeway' }],
    ['decide_request', { changeId, verdict: 'decline' }],
  ];
}

const OWN_HOME_ONLY: Record<string, string> = {
  list_on_behalf_households: 'lists the caller\'s own arrangements; the rows are filtered instead',
  pending_decisions: 'selects on the caller\'s own active grants inside the query',
  on_behalf_status: 'describes this account and this account\'s own home',
  accept_arrangement: 'acceptGrant matches the code against the caller\'s own household',
  pause_arrangement: 'setGrantState refuses a grant whose subject is not the caller\'s home',
  resume_arrangement: 'setGrantState refuses a grant whose subject is not the caller\'s home',
  end_arrangement: 'setGrantState refuses a grant whose subject is not the caller\'s home',
};

test('no tool that can reach another home gets past a revoked arrangement', () => {
  const db = world();
  const cases = reachesAnotherHome(db);
  setGrantState(db, MARIAN, grantsForDelegate(db, NADIA.id)[0]!.id, 'revoked');
  const nadia = callerFor(db, NADIA);

  for (const [name, args] of cases) {
    const err = caught<StandbyError>(() => run(db, nadia, name, args));
    assert.equal(err.name, 'StandbyError', `${name} ran for a revoked delegate`);
    assert.ok(
      ['grant_revoked', 'unknown_household', 'unknown_visit', 'unknown_change'].includes(err.code),
      `${name} refused with ${err.code}, which is not an authorisation refusal`,
    );
  }
  // And nothing was written on the way past.
  assert.equal(upcomingVisits(db, RIDGEWAY.id, nowIso()).length, 2, 'the diary changed');
});

test('the record-id tools are refused by the gate itself, not by a household hint', () => {
  // `get_visits` is refused because `Ridgeway` stops being a name the caller may say.
  // `confirm_change` takes no household at all, so if it is refused it is because the
  // gate resolved the household from the record and asked the capability engine.
  const db = world();
  const nadia = callerFor(db, NADIA);
  const offered = run(db, nadia, 'request_change', {
    household: 'Ridgeway',
    phrase: 'move the plumber',
  });
  const changeId = String(offered.facts!.changeId);
  const startsAt = String(offered.options![0]!.startsAt);
  setGrantState(db, MARIAN, grantsForDelegate(db, NADIA.id)[0]!.id, 'revoked');

  const err = caught<StandbyError>(() => run(db, nadia, 'confirm_change', { changeId, startsAt }));
  assert.equal(err.code, 'grant_revoked');
  assert.match(err.message, /was ended/);
});

test('the two lists together account for every tool, so none was quietly left out', () => {
  const db = world();
  const covered = new Set([
    ...reachesAnotherHome(db).map(([n]) => n),
    ...Object.keys(OWN_HOME_ONLY),
  ]);
  const missing = ALL_TOOLS.map((t) => t.name).filter((n) => !covered.has(n));
  assert.deepEqual(missing, [], 'a tool is in neither list, so nobody decided about it');
  for (const [name, reason] of Object.entries(OWN_HOME_ONLY)) {
    assert.ok(toolByName(name), `${name} is excused but does not exist`);
    assert.ok(reason.length > 20, `${name} is excused without a reason`);
  }
});

test('the household is never locked out of its own home by any of this', () => {
  // The gate refuses a delegate whose arrangement ended. It must not refuse the person
  // who ended it: `authorize` allows `own_household` before it looks at a grant at all.
  const db = world();
  setGrantState(db, MARIAN, grantsForDelegate(db, NADIA.id)[0]!.id, 'revoked');
  const marian = callerFor(db, MARIAN);
  const r = run(db, marian, 'get_visits');
  assert.equal(r.facts!.household, 'Ridgeway');
  assert.ok((r.rows ?? []).length > 0, 'she lost her own diary');
});

test('a paused arrangement still reads and still cannot write', () => {
  // Pausing is "not now", not "never", and the product sells that difference.
  const db = world();
  setGrantState(db, MARIAN, grantsForDelegate(db, NADIA.id)[0]!.id, 'paused');
  const nadia = callerFor(db, NADIA);
  assert.equal(run(db, nadia, 'get_visits', { household: 'Ridgeway' }).facts!.household, 'Ridgeway');
  const err = caught<StandbyError>(() =>
    run(db, nadia, 'book_visit', {
      household: 'Ridgeway',
      providerId: 'prov_halloran',
      startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      summary: 'a dripping tap',
    }),
  );
  assert.equal(err.code, 'grant_paused');
});

test('the gate refuses before the tool runs, so a denied call reads nothing', () => {
  const db = world();
  const nadia = callerFor(db, NADIA);
  const tool = toolByName('get_visits')!;
  let ran = false;
  const spy = { ...tool, run: (...a: Parameters<typeof tool.run>) => { ran = true; return tool.run(...a); } };
  setGrantState(db, MARIAN, grantsForDelegate(db, NADIA.id)[0]!.id, 'revoked');
  assert.throws(() => invokeTool(db, nadia, spy, { household: RIDGEWAY.id }));
  assert.equal(ran, false, 'the tool body ran before the refusal');
});

test('a household id is worth no more than a name it is not allowed to say', () => {
  const db = world();
  const marian = callerFor(db, MARIAN);
  const err = caught<StandbyError>(() => run(db, marian, 'get_visits', { household: CALDER.id }));
  assert.equal(err.code, 'unknown_household');
  assert.ok(!err.message.includes('Calder Street'), 'the refusal confirmed the home exists');
});

test('authorizeCall is what refuses, and it refuses with the engine\'s own words', () => {
  const db = world();
  const nadia = callerFor(db, NADIA);
  setGrantState(db, MARIAN, grantsForDelegate(db, NADIA.id)[0]!.id, 'revoked');
  const err = caught<StandbyError>(() =>
    authorizeCall(db, nadia, () => ({ household: getHousehold(db, RIDGEWAY.id)!, action: 'read' }), {}),
  );
  assert.equal(err.code, 'grant_revoked');
  // §6: whatever the guard refuses is output too. This sentence is spoken, so it must
  // contain nothing anybody typed and nothing a model wrote.
  assert.match(err.message, /The arrangement with Ridgeway was ended\./);
});
