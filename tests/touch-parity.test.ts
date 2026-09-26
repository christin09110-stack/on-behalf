// Amazon's accessibility guidance for Alexa+ add-ons requires the experience to be
// completable "touch only, including on-screen keyboard, without voice". This walks
// the tool registry against the running console and fails if a tool exists that a
// person cannot reach with their hands.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, MARIAN, NADIA } from './helpers.ts';
import { ALL_TOOLS, TOUCH_ROUTES } from '../src/mcp/tools.ts';
import { startConsole, CONSOLE_CODE } from '../src/web/server.ts';
import { mintPair } from '../src/mcp/auth.ts';
import type { Db } from '../src/db.ts';

let db: Db;
let http: ReturnType<typeof startConsole>;
let port: number;
const cookies = new Map<string, string>();

before(async () => {
  db = world();
  port = 4800 + Math.floor(Math.random() * 200);
  http = startConsole(port, db);
  await new Promise((r) => http.once('listening', r));
  for (const a of [MARIAN, NADIA]) {
    cookies.set(a.id, `standby=${mintPair(db, a.id).access_token}`);
  }
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

test('every tool declares a touch route', () => {
  for (const t of ALL_TOOLS) {
    assert.ok(t.touchRoute?.startsWith('/'), `${t.name} has no touch route`);
  }
});

test('every declared touch route is served, for both households', async () => {
  for (const route of TOUCH_ROUTES) {
    for (const account of [MARIAN.id, NADIA.id]) {
      const res = await get(route, account);
      assert.equal(res.status, 200, `${route} for ${account} returned ${res.status}`);
      const html = await res.text();
      assert.ok(html.includes('<title>'), `${route} did not render a page`);
    }
  }
});

test('no page needs JavaScript, because a script tag would make that a lie', async () => {
  for (const route of TOUCH_ROUTES) {
    const html = await (await get(route, NADIA.id)).text();
    assert.ok(!/<script/i.test(html), `${route} contains a script tag`);
  }
});

test('every page is reachable from the navigation, not only by typing a URL', async () => {
  const html = await (await get('/standby', NADIA.id)).text();
  for (const route of TOUCH_ROUTES) {
    assert.ok(html.includes(`href="${route}"`), `nothing links to ${route}`);
  }
});

test('an unlinked visitor is sent to the accounts page rather than a blank one', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/decisions`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.ok(res.headers.get('location')?.startsWith('/'));
});

test('the household pages are served in large type', async () => {
  const html = await (await get('/waiting', MARIAN.id)).text();
  assert.match(html, /<body class="big"/);
});

test('every form posts to a route the server actually handles', async () => {
  const handled = new Set([
    '/link',
    '/text-size',
    '/move',
    '/move-confirm',
    '/cancel-start',
    '/cancel-confirm',
    '/who',
    '/agree',
    '/accept-code',
    '/grant-state',
    '/draft',
    '/propose',
    '/book',
    '/adjudicate',
    '/decide',
    '/write-brief',
    '/deliver',
  ]);
  for (const route of TOUCH_ROUTES) {
    for (const account of [MARIAN.id, NADIA.id]) {
      const html = await (await get(route, account)).text();
      for (const m of html.matchAll(/<form[^>]*method="post"[^>]*action="([^"]+)"/g)) {
        assert.ok(handled.has(m[1]!), `${route} posts to ${m[1]}, which nothing handles`);
      }
    }
  }
});

test('the stylesheet is served and carries the palette', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/app.css`);
  const css = await res.text();
  assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
  // Token names, not values: a redesign is allowed to change what the colours are,
  // but the stylesheet must still define a palette rather than scatter literals
  // through the rules. These four are the ones every screen reads.
  for (const token of ['--ink', '--accent', '--card', '--line']) {
    assert.ok(css.includes(token), `the stylesheet lost ${token}`);
  }
});

test('the ledger downloads as CSV with a header row', async () => {
  const res = await get('/ledger.csv?days=90', MARIAN.id);
  const body = await res.text();
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.ok(body.startsWith('at,actor,surface,action,capability,reason'));
  assert.ok(body.split('\n').length > 1, 'the CSV has no rows in it');
});

// --------------------------------------------------------------------------- sign-in

test('linking an account needs the code this console printed', async () => {
  // `POST /link` used to mint a bearer token for whatever account id was in the form,
  // with no authentication, and it ran above the session guard. Every account id was on
  // the unauthenticated front page, so one curl was a full takeover of the other
  // household's console.
  const res = await fetch(`http://127.0.0.1:${port}/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account: NADIA.id }),
    redirect: 'manual',
  });
  assert.ok(!res.headers.get('set-cookie'), 'no token may be minted without the code');
  assert.match(decodeURIComponent(res.headers.get('location') ?? ''), /sign-in code/i);
});

test('a wrong code is refused, and so is a wrong account with a right code', async () => {
  const post = (body: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      redirect: 'manual',
    });

  const wrongCode = await post({ account: NADIA.id, code: 'not-the-code' });
  assert.ok(!wrongCode.headers.get('set-cookie'));

  const wrongAccount = await post({ account: 'acct_does_not_exist', code: CONSOLE_CODE });
  assert.ok(!wrongAccount.headers.get('set-cookie'));
});

test('the right code links the account', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account: NADIA.id, code: CONSOLE_CODE }),
    redirect: 'manual',
  });
  assert.match(res.headers.get('set-cookie') ?? '', /^standby=.+HttpOnly/);
});

test('the front page does not hand out account identifiers to a stranger', async () => {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.ok(!html.includes(NADIA.linkedSubject.slice(0, 22)), 'linked subject is not public');
});

test('large type is a control the reader can reach, on every page', async () => {
  // It used to be decided by the route: the household got large type on their own diary
  // and lost it on the ledger, and nobody could ask for it anywhere.
  for (const route of TOUCH_ROUTES) {
    const html = await (await get(route, MARIAN.id)).text();
    assert.match(html, /action="\/text-size"/, `${route} offers no text size control`);
    assert.match(html, /aria-pressed=/, `${route} does not say which size is on`);
  }
});

test('the chosen text size is remembered, and beats the route default', async () => {
  const set = async (to: string) =>
    fetch(`http://127.0.0.1:${port}/text-size`, {
      method: 'POST',
      headers: {
        cookie: cookies.get(MARIAN.id)!,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ to, from: '/ledger' }),
      redirect: 'manual',
    });

  const large = await set('large');
  assert.match(large.headers.get('set-cookie') ?? '', /textsize=large/);
  assert.match(large.headers.get('set-cookie') ?? '', /Max-Age=31536000/);

  const withPref = async (value: string, path: string) =>
    (
      await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { cookie: `${cookies.get(MARIAN.id)!}; textsize=${value}` },
        redirect: 'manual',
      })
    ).text();

  // A page that never asked for large type now honours the preference.
  assert.match(await withPref('large', '/ledger'), /<body class="big"/);
  // And a page that did ask for it yields to somebody who turned it off.
  assert.ok(!/<body class="big"/.test(await withPref('normal', '/waiting')));
});
