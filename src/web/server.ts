// The console: the touch half of the product.
//
// It is an OAuth client of the same server the Echo talks to. Signing in here runs the
// real authorization code exchange with PKCE S256, and every page afterwards is
// authorised by the resulting bearer token, exactly like a voice turn. The only thing
// standing in for Amazon is the consent screen itself.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openDb, defaultDbPath, type Db } from '../db.ts';
import { page } from './html.ts';
import * as v from './views.ts';
import {
  AuthError,
  callerFromHeader,
  issueCode,
  redeemCode,
  s256,
  type Caller,
} from '../mcp/auth.ts';
import { TOUCH_ROUTES } from '../mcp/tools.ts';
import { targetHousehold } from '../mcp/registry.ts';
import { StandbyError } from '../domain/grants.ts';
import { ScreenError } from '../domain/screening.ts';
import { ReadbackError } from '../domain/readback.ts';
import { deliver } from '../domain/outbox.ts';
import { queue } from '../domain/outbox.ts';
import { weeklyBrief } from '../domain/messages.ts';
import { draftTerms, type DraftedTerms } from '../bedrock/terms.ts';
import { adjudicate, gather } from '../bedrock/adjudicate.ts';
import { gatherBrief, writeBrief } from '../bedrock/brief.ts';
import { proposeGrant, setGrantState, acceptGrant, DEFAULT_TERMS } from '../domain/grants.ts';
import { getHousehold, getAccount } from '../domain/store.ts';
import { CSS } from './style.ts';
import { CATEGORIES, type Category } from '../types.ts';
import { nowIso } from '../clock.ts';

const TITLES: Record<string, string> = {
  '/': 'Accounts',
  '/standby': 'Both homes',
  '/home': 'The diary',
  '/waiting': 'Waiting',
  '/arrangement': 'Arrangement',
  '/providers': 'Find someone',
  '/decisions': 'Decisions',
  '/brief': 'Where things stand',
  '/ledger': 'Ledger',
  '/outbox': 'Written channel',
};

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function body(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const send = (res: ServerResponse, status: number, type: string, payload: string) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
};

const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(303, { location: to });
  res.end();
};

const back = (res: ServerResponse, to: string, kind: string, text: string) =>
  redirect(res, `${to}${to.includes('?') ? '&' : '?'}kind=${kind}&msg=${encodeURIComponent(text)}`);

/**
 * The sign-in code, and why there is one.
 *
 * In production this path does not exist: Amazon runs the consent screen, decides the
 * customer is who they say, and Standby only ever sees the authorization code that comes
 * back. The console is a local OAuth client that has to stand in for that screen, and it
 * used to stand in for it by believing the form. `POST /link` took an account id, minted
 * a bearer token for it, and set the cookie. Every account id was printed on the
 * unauthenticated front page, so one `curl` with somebody else's id was a complete
 * takeover of the other household's console — on the product whose entire premise is one
 * household acting for another.
 *
 * So the consent screen's job, proving the person at the keyboard is entitled to this
 * account, is done by a code printed to the terminal that started the server. Holding it
 * means you control the process. It is the Jupyter-token pattern and it is the honest
 * minimum: an unauthenticated form cannot be the thing that decides who you are.
 *
 * `STANDBY_CONSOLE_CODE` sets it for a scripted demo. Otherwise it is random per process,
 * which means restarting the console signs everybody out, which is correct.
 */
export const CONSOLE_CODE =
  process.env.STANDBY_CONSOLE_CODE ?? randomBytes(6).toString('base64url');

function sameCode(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(CONSOLE_CODE);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The console is an OAuth client, so signing in runs the real grant. */
function link(db: Db, accountId: string, code: string): string {
  if (!sameCode(code)) {
    throw new AuthError('access_denied', 403, 'That sign-in code is not the one this console printed.');
  }
  if (!getAccount(db, accountId)) {
    throw new AuthError('access_denied', 403, 'That sign-in code is not the one this console printed.');
  }
  const verifier = randomBytes(48).toString('base64url');
  const authCode = issueCode(db, accountId, s256(verifier), 'S256');
  return redeemCode(db, authCode, verifier).access_token;
}

/**
 * `big` here is the route's own opinion — the household's diary and the waiting page ask
 * for large type because that is who reads them. The person's saved preference wins over
 * it in both directions, so somebody who has turned large text on keeps it on the ledger
 * and the accounts page too, and somebody who has turned it off is not overruled.
 */
function renderPage(
  url: URL,
  caller: Caller | null,
  bodyHtml: string,
  big = false,
  pref: 'normal' | 'large' | null = null,
  override: { title?: string; flash?: { kind: 'ok' | 'bad' | 'needs'; text: string } } = {},
): string {
  const msg = url.searchParams.get('msg');
  return page(
    {
      title: override.title ?? TITLES[url.pathname] ?? 'On Behalf',
      path: url.pathname,
      // Every nav link carries the home the page is looking at. Without it, a delegate
      // who switched to the other household with the roster pill was silently returned
      // to their own the moment they pressed anything in the nav, with the pill gone.
      household: url.searchParams.get('household') ?? undefined,
      who: caller ? { name: caller.account.displayName, household: caller.household.name } : null,
      big: pref === null ? big : pref === 'large',
      flash:
        override.flash ??
        (msg
          ? { kind: (url.searchParams.get('kind') as 'ok' | 'bad' | 'needs') ?? 'ok', text: msg }
          : null),
    },
    bodyHtml,
  );
}

// eslint-disable-next-line complexity
async function route(db: Db, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/app.css') return send(res, 200, 'text/css; charset=utf-8', CSS);
  if (path === '/health') {
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, routes: TOUCH_ROUTES }));
  }

  const saved = cookie(req, 'textsize');
  const pref = saved === 'large' ? 'large' : saved === 'normal' ? 'normal' : null;
  const renderPageWith = (
    u: URL,
    c: Caller | null,
    bodyHtml: string,
    big = false,
    override: { title?: string; flash?: { kind: 'ok' | 'bad' | 'needs'; text: string } } = {},
  ): string => renderPage(u, c, bodyHtml, big, pref, override);

  if (req.method === 'POST' && path === '/text-size') {
    const f = await body(req);
    const to = String(f.get('to')) === 'large' ? 'large' : 'normal';
    const from = String(f.get('from') ?? '/');
    res.writeHead(303, {
      location: from.startsWith('/') ? from : '/',
      // A year, because somebody who needs larger type needs it on the next visit too.
      'set-cookie': `textsize=${to}; Path=/; Max-Age=31536000; SameSite=Lax`,
    });
    res.end();
    return;
  }

  const token = cookie(req, 'standby');
  let caller: Caller | null = null;
  try {
    caller = token ? callerFromHeader(db, `Bearer ${token}`, 'touch') : null;
  } catch {
    caller = null;
  }

  if (req.method === 'POST' && path === '/link') {
    const f = await body(req);
    const access = link(db, String(f.get('account')), String(f.get('code') ?? ''));
    res.writeHead(303, {
      location: '/standby',
      'set-cookie': `standby=${access}; Path=/; HttpOnly; SameSite=Lax`,
    });
    res.end();
    return;
  }

  if (!caller) {
    if (path === '/' && req.method === 'GET') {
      return send(res, 200, 'text/html; charset=utf-8', renderPageWith(url, null, v.accountsView(db, null)));
    }
    return back(res, '/', 'needs', 'Link an account first.');
  }

  const who = caller;
  const household = url.searchParams.get('household') ?? undefined;

  if (req.method === 'GET') {
    switch (path) {
      case '/':
        return send(res, 200, 'text/html; charset=utf-8', renderPageWith(url, who, v.accountsView(db, who)));
      case '/standby':
        return send(res, 200, 'text/html; charset=utf-8', renderPageWith(url, who, v.standbyView(db, who, household)));
      case '/home':
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          renderPageWith(url, who, v.homeView(db, who, household), !household),
        );
      case '/waiting':
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          renderPageWith(url, who, v.waitingView(db, who, household), !household),
        );
      case '/arrangement':
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          renderPageWith(url, who, v.arrangementView(db, who, undefined, household)),
        );
      case '/providers':
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          renderPageWith(url, who, v.providersView(db, who, url.searchParams.get('category') ?? 'plumbing', household)),
        );
      case '/decisions':
        return send(res, 200, 'text/html; charset=utf-8', renderPageWith(url, who, v.decisionsView(db, who, household)));
      case '/brief':
        return send(res, 200, 'text/html; charset=utf-8', renderPageWith(url, who, v.briefView(db, who, household)));
      case '/ledger':
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          renderPageWith(url, who, v.ledgerView(db, who, household, Number(url.searchParams.get('days') ?? 30))),
        );
      case '/ledger.csv':
        return send(
          res,
          200,
          'text/csv; charset=utf-8',
          v.ledgerCsv(db, targetHousehold(db, who, household).id, Number(url.searchParams.get('days') ?? 30)),
        );
      case '/outbox':
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          renderPageWith(url, who, v.outboxView(db, who, url.searchParams.get('open') ?? undefined, household)),
        );
      default:
        return send(
          res,
          404,
          'text/html; charset=utf-8',
          renderPageWith(url, who, v.notFoundView(path), false, {
            title: 'Not found',
            flash: { kind: 'bad', text: `On Behalf has no page at ${path}.` },
          }),
        );
    }
  }

  if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
  const f = await body(req);
  const house = f.get('household') ?? undefined;
  const pageOf = (html: string, big = false) =>
    send(res, 200, 'text/html; charset=utf-8', renderPageWith(url, who, html, big));

  switch (path) {
    case '/move': {
      const visitId = String(f.get('visitId'));
      const offered = v.runToolForAction(db, who, 'request_change', {
        household: house,
        phrase: '',
        visitId,
      });
      return pageOf(v.movingView(offered, house));
    }
    case '/move-confirm': {
      const r = v.runToolForAction(db, who, 'confirm_change', {
        changeId: String(f.get('changeId')),
        startsAt: String(f.get('startsAt')),
      });
      return back(
        res,
        '/home',
        r.ok ? 'ok' : 'bad',
        r.ok
          ? `Moved to ${r.facts?.day} at ${r.facts?.time}. Both homes were written to.`
          : String(r.facts?.refusal ?? 'That could not be moved.'),
      );
    }
    case '/cancel-start': {
      const r = v.runToolForAction(db, who, 'start_cancellation', { visitId: String(f.get('visitId')) });
      if (!r.ok) return back(res, '/home', 'bad', String(r.facts?.refusal ?? 'Not allowed.'));
      return pageOf(v.cancelView(r, String(f.get('visitId')), house));
    }
    case '/cancel-confirm': {
      const r = v.runToolForAction(db, who, 'confirm_cancellation', { visitId: String(f.get('visitId')) });
      return back(
        res,
        '/home',
        r.ok ? 'ok' : 'bad',
        r.ok
          ? `Cancelled. ${r.facts?.cancellationCost} to pay, and both homes were written to.`
          : String(r.facts?.refusal ?? 'That could not be cancelled.'),
      );
    }
    case '/who': {
      const r = v.runToolForAction(db, who, 'who_arranged', {
        household: house,
        visitId: String(f.get('visitId')),
      });
      return back(
        res,
        '/home',
        'ok',
        r.ok
          ? `${r.facts?.arrangedBy} arranged ${r.facts?.provider} on ${r.facts?.arrangedOn}.`
          : 'On Behalf has no record of that visit.',
      );
    }
    case '/agree': {
      const r = v.runToolForAction(db, who, 'agree_to_visit', { visitId: String(f.get('visitId')) });
      return back(res, '/waiting', r.ok ? 'ok' : 'bad', r.ok ? 'Agreed, and both homes were told.' : 'Nothing was waiting.');
    }
    case '/accept-code': {
      const g = acceptGrant(db, who.account, String(f.get('code')), 'touch');
      const delegate = getAccount(db, g.delegateAccount)?.displayName ?? 'they';
      return back(res, '/arrangement', 'ok', `Accepted. ${delegate} can now help, on the terms shown here.`);
    }
    case '/grant-state': {
      const next = String(f.get('next')) as 'active' | 'paused' | 'revoked';
      setGrantState(db, who.account, String(f.get('grantId')), next);
      return back(
        res,
        '/arrangement',
        next === 'active' ? 'ok' : 'needs',
        next === 'active'
          ? 'Started again.'
          : `${next === 'paused' ? 'Paused' : 'Ended'}. Visits already in the diary stand.`,
      );
    }
    case '/draft': {
      const drafted: DraftedTerms = await draftTerms(String(f.get('sentence') ?? ''));
      return pageOf(v.draftedView(drafted, db, who));
    }
    case '/propose': {
      const cats = f
        .getAll('categories')
        .filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c));
      const target = getHousehold(db, String(f.get('household')));
      if (!target) return back(res, '/arrangement', 'bad', 'On Behalf does not know that home.');
      const g = proposeGrant(db, who.account, target, {
        ...DEFAULT_TERMS,
        categories: cats.length ? cats : DEFAULT_TERMS.categories,
        spendCapCents: Math.max(100, Number(f.get('cap') ?? 250) * 100),
        noticeHours: Number(f.get('notice') ?? 24),
        earliestHour: Number(f.get('from') ?? 9),
        latestHour: Number(f.get('to') ?? 17),
        mayBook: f.get('mayBook') !== null,
        mayReschedule: f.get('mayReschedule') !== null,
        mayCancel: f.get('mayCancel') !== null,
      });
      return back(
        res,
        '/arrangement',
        'needs',
        `Proposed. Nothing is granted until ${target.name} accepts. The code is ${g.pairingCode}.`,
      );
    }
    case '/book': {
      const r = v.runToolForAction(db, who, 'book_visit', {
        household: house,
        providerId: String(f.get('providerId')),
        startsAt: String(f.get('startsAt')),
        summary: String(f.get('summary') ?? ''),
      });
      return back(
        res,
        '/home' + (house ? `?household=${encodeURIComponent(house)}` : ''),
        r.ok ? (r.code === 'booked' ? 'ok' : 'needs') : 'bad',
        r.ok
          ? (r.code === 'booked'
              ? `${r.facts?.provider} is booked for ${r.facts?.day} at ${r.facts?.time}. Reference ${r.facts?.reference}.`
              : `Held. Somebody at ${r.facts?.household} has to agree before it goes ahead.`) +
            // Said at the point of booking, not only afterwards in the ledger.
            (r.facts?.clash ? ` ${r.facts.clash}` : '')
          : String(r.facts?.refusal ?? 'That could not be booked.'),
      );
    }
    case '/adjudicate': {
      const changeId = String(f.get('changeId'));
      const input = gather(db, who.account, changeId);
      if (!input) return back(res, '/decisions', 'bad', 'That request is no longer waiting.');
      const adj = await adjudicate(db, input);
      return pageOf(v.adjudicationView(adj, changeId));
    }
    case '/decide': {
      const r = v.runToolForAction(db, who, 'decide_request', {
        changeId: String(f.get('changeId')),
        verdict: String(f.get('verdict')),
      });
      return back(
        res,
        '/decisions',
        r.ok ? 'ok' : 'bad',
        r.ok
          ? r.code === 'booked'
            ? `Booked for ${r.facts?.day} at ${r.facts?.time}.`
            : r.code === 'declined'
              ? 'Declined, and the household was told nothing is being arranged.'
              : 'Agreed, and it now waits for the household because it is above their limit.'
          : String(r.facts?.refusal ?? 'That could not be decided.'),
      );
    }
    case '/write-brief': {
      const target = getHousehold(db, house ?? '') ?? who.household;
      const result = await writeBrief(gatherBrief(db, who.account, target));
      db.prepare(
        `INSERT OR REPLACE INTO brief (householdId, delegateAccount, at, body, fromFallback, model)
         VALUES (?,?,?,?,?,?)`,
      ).run(target.id, who.account.id, nowIso(), result.body, result.fromFallback ? 1 : 0, result.model);
      queue(
        db,
        weeklyBrief({
          to: who.account,
          house: target,
          body: result.body,
          fromFallback: result.fromFallback,
        }),
      );
      deliver(db);
      return back(res, `/brief?household=${encodeURIComponent(target.id)}`, 'ok', 'Written and sent to your own inbox.');
    }
    case '/deliver': {
      const r = deliver(db);
      return back(res, '/outbox', 'ok', `${r.sent} sent, ${r.failed} left to retry.`);
    }
    default:
      return send(res, 404, 'text/plain', 'not found');
  }
}

export function startConsole(port = Number(process.env.CONSOLE_PORT ?? 4173), db?: Db) {
  const database = db ?? openDb(defaultDbPath());
  const http = createServer((req, res) => {
    route(database, req, res).catch((e: unknown) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const known =
        e instanceof StandbyError ||
        e instanceof ScreenError ||
        e instanceof ReadbackError ||
        e instanceof AuthError;
      if (known) return back(res, url.pathname === '/link' ? '/' : url.pathname, 'bad', (e as Error).message);
      process.stderr.write(`console error: ${String(e)}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('something went wrong');
    });
  });
  http.listen(port, () => {
    process.stdout.write(`On Behalf console on http://localhost:${port}\n`);
    process.stdout.write(`Sign-in code: ${CONSOLE_CODE}\n`);
  });
  return http;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  startConsole();
}
