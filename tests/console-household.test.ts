// `?household=` used to be honoured on four routes and dropped, without a word, on five.
//
// The four that worked were `/home`, `/providers`, `/brief` and `/ledger` — which are
// exactly the four a delegated screen had ever been photographed on. A delegate asking
// for the other household's waiting list was served her own, headed "Nothing needs you",
// while two things were outstanding at her mother's house. That is not a routing bug on
// this product: it is the console answering about the wrong home.
//
// So this walks every route rather than a chosen few, and it checks the case that was
// broken rather than the case that worked.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, MARIAN, NADIA, RIDGEWAY, CALDER } from './helpers.ts';
import { story } from '../src/seed.ts';
import { startConsole } from '../src/web/server.ts';
import { mintPair } from '../src/mcp/auth.ts';
import { TOUCH_ROUTES } from '../src/mcp/tools.ts';
import type { Db } from '../src/db.ts';

/** Every signed-in page, including the one `TOUCH_ROUTES` leaves out. */
const ROUTES = [...new Set([...TOUCH_ROUTES, '/outbox'])].filter((r) => r !== '/');

let db: Db;
let http: ReturnType<typeof startConsole>;
let port: number;
const cookies = new Map<string, string>();

before(async () => {
  db = world();
  story(db);
  port = 5100 + Math.floor(Math.random() * 300);
  http = startConsole(port, db);
  await new Promise((r) => http.once('listening', r));
  for (const a of [MARIAN, NADIA]) cookies.set(a.id, `standby=${mintPair(db, a.id).access_token}`);
});

after(() => {
  http.close();
  db.close();
});

async function html(path: string, account: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { cookie: cookies.get(account)! },
    redirect: 'manual',
  });
  assert.equal(res.status, 200, `${path} returned ${res.status}`);
  return res.text();
}

test('every route Nadia can reach honours the household she asked for', async () => {
  for (const route of ROUTES) {
    const body = await html(`${route}?household=${RIDGEWAY.id}`, NADIA.id);
    assert.match(
      body,
      /You are acting for <span class="band-home">Marian at Ridgeway<\/span>/,
      `${route} did not say whose home it is showing`,
    );
    assert.match(body, /side-label">Looking at</, `${route} lost the household picker`);
    assert.doesNotMatch(
      body,
      /<span class="band-home">Calder Street<\/span>, your own home/,
      `${route} substituted Nadia's own home`,
    );
  }
});

test('the waiting page shows the other household what is actually waiting there', async () => {
  // The screen the audit called the clearest harm: Ridgeway has a boiler visit held for
  // Marian and a gutter request held for Nadia, and this page said "Nothing needs you".
  const delegated = await html(`/waiting?household=${RIDGEWAY.id}`, NADIA.id);
  assert.doesNotMatch(delegated, /Nothing needs you/);
  assert.match(delegated, /Bellweather Heating/);

  // And Nadia's own waiting list is still her own, and still empty.
  const own = await html('/waiting', NADIA.id);
  assert.match(own, /Nothing needs you/);
  assert.doesNotMatch(own, /Bellweather Heating/);
});

test('the household a page is looking at survives pressing something in the nav', async () => {
  const body = await html(`/ledger?household=${RIDGEWAY.id}`, NADIA.id);
  for (const route of ROUTES) {
    assert.ok(
      body.includes(`href="${route}?household=${RIDGEWAY.id}"`),
      `the nav link to ${route} dropped the household`,
    );
  }
});

test('a household Nadia may not act in is refused on every route, not quietly swapped', async () => {
  for (const route of ROUTES) {
    const res = await fetch(`http://127.0.0.1:${port}${route}?household=house_nowhere`, {
      headers: { cookie: cookies.get(NADIA.id)! },
      redirect: 'manual',
    });
    assert.equal(res.status, 303, `${route} served a page for a home that does not exist`);
    assert.match(
      decodeURIComponent(res.headers.get('location') ?? ''),
      /On Behalf does not know a home called house_nowhere that you can act in\./,
      `${route} did not say why it refused`,
    );
  }
});

test("Marian cannot reach Nadia's home by naming it, on any route", async () => {
  for (const route of ROUTES) {
    const res = await fetch(`http://127.0.0.1:${port}${route}?household=${CALDER.id}`, {
      headers: { cookie: cookies.get(MARIAN.id)! },
      redirect: 'manual',
    });
    assert.equal(res.status, 303, `${route} let Marian into Calder Street`);
    assert.match(decodeURIComponent(res.headers.get('location') ?? ''), /does not know a home called/);
  }
});

test('the front page names the two sides from the arrangement, not from the row order', async () => {
  // `allHouseholds` sorts by name, so Calder Street comes back first and the labels used
  // to introduce the helper as the household being helped — contradicting the README
  // sentence two paragraphs above them.
  const body = await html('/', NADIA.id);
  const helped = body.indexOf('The home being helped');
  const helping = body.indexOf('The person helping');
  assert.ok(helped >= 0 && helping >= 0, 'the two sides are labelled');
  assert.match(
    body.slice(helped, helping),
    /class="name">Marian</,
    'the home being helped is Marian at Ridgeway',
  );
  assert.match(body.slice(helping), /class="name">Nadia</, 'the person helping is Nadia');
});
