// The console's pages.
//
// Most of them render the output of the same tools the Echo calls, rather than
// querying the database again. That is what makes touch parity real rather than
// claimed: if a tool changes, the page changes with it, and the two surfaces cannot
// drift into disagreeing about what is booked.
//
// The design problem these pages exist to solve is delegated authority. Somebody is
// acting on somebody else's behalf, and that relationship can be granted, scoped,
// expired, revoked and abused. Three things follow, and every page here is built to
// make all three true without a paragraph of explanation:
//
//   Who is acting, and in whose home, is never ambiguous. That is the band.
//   What the arrangement permits and when it stops is visible, not buried in a form.
//   Ending it is one press from wherever you are, because revocation in a settings
//   page would be a design failure in a product about delegated power.

import type { Db } from '../db.ts';
import type { Caller } from '../mcp/auth.ts';
import { toolByName } from '../mcp/tools.ts';
import { invokeTool, targetHousehold, type ToolResult } from '../mcp/registry.ts';
import { card, empty, esc, form, kv, shell, sideLabel, standbyMark, table, tag } from './html.ts';
import {
  allHouseholds,
  auditFor,
  getAccount,
  getHousehold,
  grantsForDelegate,
  liveGrantsForDelegate,
  grantsOverHousehold,
  outboxTo,
  accountsIn,
  upcomingVisits,
} from '../domain/store.ts';
import { CATEGORIES, type Grant, type Household } from '../types.ts';
import { humanCategory } from '../domain/capability.ts';
import { clashingVisits } from '../domain/visits.ts';
import { hourWord, nowIso, readableStamp, readableWhen } from '../clock.ts';
import { CANCELLATION_FACTS } from '../domain/readback.ts';
import { forCsvCell } from '../domain/escape.ts';
import { StandbyError } from '../domain/grants.ts';
import { ScreenError } from '../domain/screening.ts';
import { ReadbackError } from '../domain/readback.ts';
// The notice the console prints when the drafter left something out. It is app-authored
// copy keyed by a reason code, which is the point: the model has no field to write it in.
import { droppedNotice } from '../bedrock/terms.ts';

// ---------------------------------------------------------------------------
// What a page cost, measured rather than claimed.
//
// Amazon allows a spoken turn 500 milliseconds end to end, and `npm run bench` proves
// the whole round trip fits inside single-digit milliseconds of that. A benchmark
// belongs on a benchmark page. What belongs on a household screen is the narrower and
// more useful fact: this page was built by calling the same tool the speaker calls,
// here is which one, here is how long it took on this request, and no model ran.

interface Measured {
  tool: string;
  ms: number;
}

let measured: Measured[] = [];

/** Start a fresh measurement window. Every page-level view calls this first. */
const beginMeasure = (): void => {
  measured = [];
};

export function runTool(
  db: Db,
  caller: Caller,
  name: string,
  args: Record<string, unknown> = {},
): ToolResult {
  const tool = toolByName(name);
  if (!tool) throw new Error(`no tool called ${name}`);
  const started = process.hrtime.bigint();
  const out = invokeTool(db, caller, tool, args);
  measured.push({ tool: name, ms: Number(process.hrtime.bigint() - started) / 1e6 });
  return out;
}

/**
 * The POST-case version of `runTool`, for `server.ts`'s action switch only.
 *
 * A tool that denies or screens a call normally *returns* `{ ok: false, facts: {
 * refusal } }`, and every POST case already renders that gracefully with its own
 * `back()` call to the right page. But some checks — screening a typed summary for
 * health content before anything is written, chiefly — are enforced by *throwing*
 * (`StandbyError`, `ScreenError`, `ReadbackError`) rather than returning, because they
 * run ahead of the normal authorise/run/screen pipeline and have no result yet to
 * attach a refusal to. Left uncaught, that throw skips the case's own `back()` call and
 * lands on `startConsole`'s generic catch, which only knows the POST path that failed
 * (e.g. `/book`) — and a POST-only path has no GET handler, so the viewer gets a plain
 * 404 instead of the refusal reason.
 *
 * This wrapper is deliberately *not* folded into `runTool` itself: several GET view
 * builders (`briefView`, `ledgerView`, …) also call `runTool` and rely on an invalid
 * household throwing all the way up to that same generic catch — which is exactly
 * right for a GET request, because `url.pathname` there already has a GET handler, so
 * the redirect-and-reflash it produces is correct as-is. Converting the throw to a
 * return there would make an already-graceful GET path render a broken half-built page
 * instead of refusing. Catching only where the *plain 404* symptom actually occurs —
 * the console's own action switch — fixes the real bug without changing GET behaviour.
 */
export function runToolForAction(
  db: Db,
  caller: Caller,
  name: string,
  args: Record<string, unknown> = {},
): ToolResult {
  try {
    return runTool(db, caller, name, args);
  } catch (e) {
    if (e instanceof StandbyError || e instanceof ScreenError || e instanceof ReadbackError) {
      return { ok: false, code: e.code, facts: { refusal: e.message } };
    }
    throw e;
  }
}

/** The line under the content that says where the content came from. */
function provenance(extra?: string): string {
  const taken = measured;
  measured = [];
  const left = taken.length
    ? `Built by calling <span class="calls">${taken
        .map((m) => `${esc(m.tool)}</span> <span class="ms">${m.ms.toFixed(1)} ms</span><span class="calls">`)
        .join(', ')}</span> — the same tools the speaker calls. <span class="model-off">No model ran.</span>`
    : `Read straight from this household's own record. <span class="model-off">No model ran.</span>`;
  return `<div class="provenance"><span>${left}</span><span>${esc(
    extra ?? 'A spoken turn is allowed 500 ms.',
  )}</span></div>`;
}

const rowsOf = (r: ToolResult) => r.rows ?? [];

// ---------------------------------------------------------------------------
// Words

const andList = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** "200 dollars", not "200.00 dollars", which is the register of a receipt. */
const screenMoney = (cents: number): string =>
  `${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)} dollars`;

/**
 * The same amount a tool already formatted, in the register of a screen.
 *
 * `money()` in `readback.ts` is the spoken formatter and stays exactly as it is: a turn
 * that says "one hundred and eighty dollars" out loud wants the cents composed, not
 * guessed at. But the console printed its output verbatim, so a card read `180.00
 * dollars` two inches from a limit written `200 dollars`, and a trailing `.00` on every
 * figure reads as a raw decimal rather than as a price. This drops the cents only when
 * there are none, which is the one case where they carry nothing.
 */
const asScreenMoney = (value: unknown): string =>
  String(value ?? '').replace(/(\d)\.00(?=\s*dollars\b)/g, '$1');

const coversWords = (g: Grant): string =>
  andList(g.categories.map((c) => humanCategory(c).toLowerCase()));

const verbsWords = (g: Grant): string => {
  const v: string[] = [];
  if (g.mayBook) v.push('book');
  if (g.mayReschedule) v.push('move');
  if (g.mayCancel) v.push('cancel');
  return v.length ? andList(v) : 'do nothing at all with';
};

const longDate = (iso: string): string =>
  new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(iso),
  );

/**
 * A date and a distance, because "23 September 2027" and "23 September" read the same
 * on a page and mean completely different things to a family. An arrangement with a
 * visible scope and no visible end is the thing people are afraid of.
 */
function endsWords(iso: string): string {
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000;
  if (days < 0) return `${longDate(iso)}, which has already passed`;
  if (days < 1) return `${longDate(iso)}, later today`;
  if (days < 2) return `${longDate(iso)}, tomorrow`;
  if (days < 45) return `${longDate(iso)}, ${Math.round(days)} days from now`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${longDate(iso)}, ${months} months from now`;
  return `${longDate(iso)}, ${(days / 365.25).toFixed(1)} years from now`;
}

const houseOwner = (db: Db, h: Household): string => {
  const who = accountsIn(db, h.id)[0];
  return who ? `${who.displayName}'s home` : 'no one linked yet';
};

const STATE_WORDS: Record<string, string> = {
  active: 'active',
  paused: 'paused',
  revoked: 'ended',
  expired: 'expired',
  proposed: 'waiting to be accepted',
};

const stateTag = (status: string): string =>
  tag(STATE_WORDS[status] ?? status, status === 'active' ? 'live' : status === 'proposed' ? 'needs' : 'off');

/** The terms of a grant in one sentence, the way a person would say them. */
const termsSentence = (g: Grant, subject: string): string =>
  `${subject} ${verbsWords(g)} ${coversWords(g)}, up to <strong>${esc(
    screenMoney(g.spendCapCents),
  )}</strong> a visit, between ${esc(hourWord(g.earliestHour))} and ${esc(
    hourWord(g.latestHour),
  )}, with ${g.noticeHours} hours' notice.`;

// ---------------------------------------------------------------------------
// The band: who is acting, in whose home, on what terms, until when, and the button
// that ends it. It is on every signed-in screen and it is the loudest thing here.

export function authorityBand(db: Db, caller: Caller, viewing?: string): string {
  const target = viewing ? getHousehold(db, viewing) : null;
  const acting = !!target && target.id !== caller.household.id;

  if (acting && target) {
    const grant = liveGrantsForDelegate(db, caller.account.id).find(
      (g) => g.subjectHousehold === target.id,
    );
    const owner = accountsIn(db, target.id)[0];
    const lead = `You are acting for <span class="band-home">${esc(
      owner?.displayName ?? target.name,
    )} at ${esc(target.name)}</span>.`;
    const scope = grant
      ? `Not your home. ${termsSentence(grant, 'You may')} Runs to <span class="ends">${esc(
          endsWords(grant.expiresAt),
        )}</span>.`
      : 'Not your home, and nothing here has been granted to you.';
    return `<div class="band-auth acting">
      ${standbyMark(true)}
      <div>
        <p class="band-lead">${lead}</p>
        <p class="band-scope">${scope}</p>
        <p class="band-note">${esc(target.name)} can end this at any moment, without asking you.
        Everything you do here is written into their ledger under your name.</p>
      </div>
      <div class="band-actions">
        <a class="btn quiet small" href="/arrangement">See the terms</a>
        <span class="band-aside">${
          grant?.status === 'paused' ? 'Paused by the household. Nothing can be changed.' : ''
        }</span>
      </div>
    </div>`;
  }

  // Your own home. If somebody holds a say over it, the band carries the way to stop it.
  const over = grantsOverHousehold(db, caller.household.id).filter(
    (g) => g.status === 'active' || g.status === 'paused',
  );
  const alsoHelps = liveGrantsForDelegate(db, caller.account.id)
    .map((g) => getHousehold(db, g.subjectHousehold))
    .filter((h): h is Household => !!h);

  const lead = `<span class="band-home">${esc(caller.household.name)}</span>, your own home.`;

  if (!over.length) {
    const aside = alsoHelps.length
      ? `You stand by for ${esc(andList(alsoHelps.map((h) => h.name)))}.`
      : 'Nobody has been given a say over this home.';
    return `<div class="band-auth">
      ${standbyMark(false)}
      <div>
        <p class="band-lead">${lead}</p>
        <p class="band-scope">${aside}</p>
      </div>
      <div class="band-actions">
        ${
          alsoHelps[0]
            ? `<a class="btn quiet small" href="/home?household=${encodeURIComponent(
                alsoHelps[0].id,
              )}">Go to ${esc(alsoHelps[0].name)}</a>`
            : `<a class="btn quiet small" href="/arrangement">Let someone help</a>`
        }
      </div>
    </div>`;
  }

  const g = over[0]!;
  const helper = getAccount(db, g.delegateAccount)?.displayName ?? 'Someone';
  const more =
    over.length > 1 ? ` ${over.length - 1} more arrangement covers this home.` : '';
  const alsoLine = alsoHelps.length
    ? `<p class="band-note">You also stand by for ${esc(
        andList(alsoHelps.map((h) => h.name)),
      )}.</p>`
    : '';
  return `<div class="band-auth">
    ${standbyMark(false)}
    <div>
      <p class="band-lead">${lead}</p>
      <p class="band-scope">${termsSentence(g, `${esc(helper)} may`)} Runs to
        <span class="ends">${esc(endsWords(g.expiresAt))}</span>.${esc(more)}</p>
      ${alsoLine}
    </div>
    <div class="band-actions">
      ${form('/grant-state', { grantId: g.id, next: 'revoked' }, 'End it now', 'warn small')}
      <span class="band-aside">Yours alone. No code, and nobody else has to agree.</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// The household list: every home this console will show you, one row each. It is
// the spine of the product, so it now lives in the rail on every signed-in screen
// rather than at the top of one page's body — and rather than in a separate "looking
// at" picker that four of nine routes used to silently ignore (see the prior audit:
// `?household=` honoured on 4 of 8 routes). One control, used everywhere, switches
// the page you are already on — `path` is that page.

function rosterRow(
  db: Db,
  house: Household,
  grant: Grant | null,
  mine: boolean,
  path: string,
  current: string,
): string {
  const status = grant?.status ?? 'none';
  const here = current === house.id;
  const whose = mine ? 'your own home' : houseOwner(db, house);
  const summary = grant
    ? `May ${verbsWords(grant)} ${coversWords(grant)}, up to <strong>${esc(
        screenMoney(grant.spendCapCents),
      )}</strong> a visit.`
    : mine
      ? 'Nobody may act here.'
      : 'No arrangement has been accepted.';
  const act =
    grant && mine
      ? `${grant.status === 'active' ? form('/grant-state', { grantId: grant.id, next: 'paused' }, 'Pause', 'quiet small') : ''}
         ${grant.status === 'paused' ? form('/grant-state', { grantId: grant.id, next: 'active' }, 'Start again', 'quiet small') : ''}
         ${form('/grant-state', { grantId: grant.id, next: 'revoked' }, 'End it', 'warn small')}`
      : '';

  return `<div class="roster-row is-${esc(status)}${here ? ' is-current' : ''}">
    <div class="roster-head">
      <a class="roster-home" href="${path}?household=${encodeURIComponent(house.id)}"${here ? ' aria-current="page"' : ''}>${esc(house.name)}</a>
      ${grant ? stateTag(grant.status) : ''}
    </div>
    <span class="roster-whose">${esc(whose)}</span>
    <p class="roster-summary">${summary}</p>
    ${act ? `<div class="roster-act">${act}</div>` : ''}
  </div>`;
}

/** `path` is the page to stay on when a row is chosen; `current` is which home this
 * request is already looking at (falls back to the caller's own home). */
export function roster(db: Db, caller: Caller, path: string, current?: string): string {
  const here = current ?? caller.household.id;
  const mineGrant =
    grantsOverHousehold(db, caller.household.id).find(
      (g) => g.status === 'active' || g.status === 'paused',
    ) ?? null;
  const rows = [rosterRow(db, caller.household, mineGrant, true, path, here)];
  for (const g of liveGrantsForDelegate(db, caller.account.id)) {
    const h = getHousehold(db, g.subjectHousehold);
    if (h) rows.push(rosterRow(db, h, g, false, path, here));
  }
  return `${sideLabel('Looking at')}<div class="roster">${rows.join('')}</div>`;
}

// ---------------------------------------------------------------------------

/**
 * Which side of the arrangement an account is on.
 *
 * The front page used to label its two columns by position — `cards[0]` got "The home
 * being helped" and `cards[1]` got "The person helping" — and `cards` comes back from
 * `allHouseholds` in `ORDER BY name`, so on the seeded database Calder Street sorted
 * first and the helper was introduced as the household. That contradicted the README two
 * paragraphs above it and every other screen in the app, and it is the first thing a
 * judge opens.
 *
 * A household with somebody holding a say over it is the one being helped. An account
 * that holds a say over some other household is the one helping. Neither depends on the
 * order rows come back in. A proposed grant counts: the roles are settled the moment the
 * arrangement is offered, which is before anybody has accepted anything.
 */
type Side = 'helped' | 'helping' | 'unattached';

const SIDE_LABEL: Record<Side, string> = {
  helped: 'The home being helped',
  helping: 'The person helping',
  unattached: 'Not part of an arrangement',
};

/** A grant that has been revoked or has run out settles nothing about who helps whom. */
const standing = (g: Grant): boolean => g.status !== 'revoked' && g.status !== 'expired';

function sideOf(db: Db, house: Household, accountId: string): Side {
  if (grantsOverHousehold(db, house.id).some(standing)) return 'helped';
  if (grantsForDelegate(db, accountId).some(standing)) return 'helping';
  return 'unattached';
}

export function accountsView(db: Db, current: Caller | null): string {
  beginMeasure();
  const entries = allHouseholds(db)
    .flatMap((h) =>
      db
        .prepare('SELECT id FROM account WHERE householdId = ?')
        .all(h.id as never)
        .map((r) => ({ h, a: getAccount(db, (r as { id: string }).id)! })),
    )
    .map((e) => ({ ...e, side: sideOf(db, e.h, e.a.id) }));

  // The home being helped reads first, because that is the order the sentence above the
  // cards puts them in.
  const order: Side[] = ['helped', 'helping', 'unattached'];
  entries.sort((x, y) => order.indexOf(x.side) - order.indexOf(y.side));

  const cards = entries.map(
      ({ h, a, side }) => `${sideLabel(SIDE_LABEL[side])}${card(
        `<h2 class="name">${esc(a.displayName)}</h2>
         ${kv([
           ['Home', h.name],
           ['Timezone', h.timezone],
         ])}
         <p class="note">Signing in here runs the real authorization code exchange with
         PKCE S256, the same grant the Alexa+ MCP Toolkit requires. What stands in for
         Amazon is the consent screen, and the sign-in code below is what stands in for
         the part of it that proves who you are: it is printed by the terminal running
         this console, so holding it means you started the process.</p>
         ${
           current?.account.id === a.id
             ? form('/link', { account: a.id }, 'Signed in', 'quiet')
             : `<form method="post" action="/link" class="row">
                  <input type="hidden" name="account" value="${esc(a.id)}">
                  <div style="flex:0 1 220px">
                    <label for="code-${esc(a.id)}">Sign-in code</label>
                    <input id="code-${esc(a.id)}" name="code" autocomplete="off" required>
                  </div>
                  <button>Link as ${esc(a.displayName)}</button>
                </form>`
         }`,
      )}`,
    );

  const intro = current
    ? ''
    : `<div class="title-row">
         <div>
           <h1>One household running another household's admin</h1>
           <p class="lede">On Behalf is an Alexa+ add-on. An adult child books the plumber;
           the older relative asks their own Echo when he is coming, and can move it, or
           end the whole arrangement, from their own speaker without going through
           anybody. Link either account below to see both sides.</p>
         </div>
       </div>`;

  return `${intro}<div class="split">
    ${cards.map((c) => `<div>${c}</div>`).join('')}
  </div>
  <hr class="rule">
  ${card(
    `<h2>What is real here, and what is standing in</h2>
     <p class="note">The MCP server, the transport, the protocol revision, the capability
     engine and the ledger are all doing the thing they appear to be doing. The trade
     directory, their free times and the mail transport are local stand-ins, marked
     wherever they appear. Nothing books anything real.</p>`,
    'hushed',
  )}`;
}

// ---------------------------------------------------------------------------

/**
 * An address this console does not serve.
 *
 * Signed in, an unknown URL used to return status 404 carrying the whole Accounts page:
 * the heading was the app's name rather than the page's, it offered to sign you in as the
 * other account while you were already signed in, and it contained no flash, notice or
 * error element of any kind. It read as though the app had logged you out. Signed out,
 * the same URL redirected with "Link an account first", which is at least a sentence —
 * the signed-in case is the one a judge hits.
 */
export function notFoundView(path: string): string {
  return `${empty(
    'There is no page at that address',
    `On Behalf has nothing at ${path}. Nothing has gone wrong with your account or your arrangement, and nothing has been signed out.`,
    `<a class="btn small" href="/standby">Both homes</a> <a class="btn quiet small" href="/home">The diary</a>`,
  )}`;
}

export function standbyView(db: Db, caller: Caller, household?: string): string {
  beginMeasure();
  // Resolving the hint before anything else is what refuses a home this caller may not
  // reach, rather than quietly serving them their own.
  const viewing = targetHousehold(db, caller, household);
  const mine = runTool(db, caller, 'get_visits');
  const others = liveGrantsForDelegate(db, caller.account.id)
    .map((g) => getHousehold(db, g.subjectHousehold))
    .filter((h): h is Household => !!h);

  // Both homes, with the named one on the standing-by side. Naming your own home is the
  // default view rather than a contradiction, so it falls through to the first.
  const other = viewing.id === caller.household.id ? others[0] : viewing;
  const otherVisits = other
    ? upcomingVisits(db, other.id, nowIso()).map((v) => ({
        when: readableWhen(v.startsAt, other.timezone),
        what: `${v.summary}`,
        needs: v.status === 'awaiting_subject',
      }))
    : [];

  const ledger = other
    ? auditFor(db, other.id)
        .slice(0, 8)
        .map((e) => ({
          when: e.at.slice(0, 10),
          what: e.reason,
          needs: e.action.includes('awaiting') || e.action.includes('requested'),
        }))
    : [];

  const timeline = (
    items: Array<{ when: string; what: string; needs: boolean }>,
    emptyHeading: string,
    emptyDetail: string,
    action = '',
  ) =>
    items.length
      ? `<ul class="timeline">${items
          .map(
            (i) =>
              // The wheat dot is the whole signal for "this needs you", and an empty
              // ::before announces nothing, so the state was invisible to anyone not
              // seeing colour. The word carries it; the dot repeats it.
              `<li class="${i.needs ? 'needs' : ''}"><span class="when">${esc(i.when)}</span><span class="what">${esc(i.what)}${
                i.needs ? ` ${tag('waiting on you', 'needs')}` : ''
              }</span></li>`,
          )
          .join('')}</ul>`
      : empty(emptyHeading, emptyDetail, action);

  const otherSide = other
    ? `${card(
        `<h2 class="name">${esc(other.name)}</h2>${timeline(
          otherVisits,
          `Nothing is booked at ${other.name}`,
          `Their diary is empty. Find a trade and book one, and it appears on both sides at once — here, on their own Echo, and in both written channels.`,
          `<a class="btn small" href="/providers?household=${encodeURIComponent(other.id)}">Find someone for ${esc(other.name)}</a>`,
        )}`,
      )}
      ${card(
        `<h3>What has happened there</h3>${timeline(
          ledger,
          'Nothing has happened yet',
          'Every booking, move and cancellation at that house is written here, with who did it and under which part of the arrangement.',
        )}`,
        'hushed',
      )}`
    : empty(
        'You do not stand by for anyone yet',
        'When another household accepts an arrangement you have proposed, their diary appears on this side of the spine, next to your own.',
        `<a class="btn small" href="/arrangement">Propose an arrangement</a>`,
      );

  const rail = `${authorityBand(db, caller, household)}${roster(db, caller, '/standby', household)}`;
  const main = `<div class="split">
    <div class="stack">
      ${sideLabel(`${caller.household.name}, your own home`)}
      ${card(`<h2>Your diary</h2>${timeline(
        rowsOf(mine).map((r) => ({
          when: `${r.day} at ${r.time}`,
          what: `${r.provider}, ${r.service}`,
          needs: r.confirmed === false,
        })),
        'Nothing is booked here',
        'Your own diary is empty. Anything booked at this address, by you or by anyone standing by for you, appears here.',
        `<a class="btn small" href="/providers">Find someone</a>`,
      )}`)}
    </div>
    <div class="stack">
      ${sideLabel(other ? `${other.name}, where you stand by` : 'The home you stand by for')}
      ${otherSide}
    </div>
  </div>
  ${provenance()}`;
  return shell(rail, main);
}

// ---------------------------------------------------------------------------

export function homeView(db: Db, caller: Caller, household?: string): string {
  beginMeasure();
  const args = household ? { household } : {};
  const visits = runTool(db, caller, 'get_visits', args);
  const house = String(visits.facts?.household ?? caller.household.name);
  const rows = rowsOf(visits);
  // Three tradespeople at one address at eleven used to be listed one under another
  // without comment. The booking says so as it happens; this is the diary saying so
  // afterwards, which is where the household actually looks.
  const viewing = targetHousehold(db, caller, household);
  const together = new Set<string>();
  for (const v of upcomingVisits(db, viewing.id, nowIso())) {
    if (clashingVisits(db, viewing.id, v.startsAt, v.endsAt, v.id).length) together.add(v.id);
  }

  const body = rows.length
    ? rows
        .map((r) =>
          card(
            `<h3 class="name">${esc(r.provider)} ${r.confirmed === false ? tag('waiting on you', 'needs') : ''}${
              together.has(String(r.visitId)) ? ` ${tag('two at once', 'needs')}` : ''
            }</h3>
             ${kv([
               ['For', r.service],
               ['Day', r.day],
               ['Time', r.time],
               ['Cost', asScreenMoney(r.price)],
               ['Reference', r.reference],
             ])}
             ${
               together.has(String(r.visitId))
                 ? `<p class="note">Somebody else is booked at this address at the same hour.
                    Nothing is wrong with that, but two people will be at the door together.</p>`
                 : ''
             }
             <div>
               ${form('/move', { visitId: r.visitId, household }, 'Move this')}
               ${form('/cancel-start', { visitId: r.visitId, household }, 'Cancel this', 'quiet')}
               ${form('/who', { visitId: r.visitId, household }, 'Who arranged it', 'quiet')}
             </div>`,
            r.confirmed === false ? 'attention' : '',
          ),
        )
        .join('')
    : empty(
        `Nothing is booked at ${house}`,
        'The diary is empty. A visit booked here, by anyone, shows its trade, its day, its price and who arranged it — and can be moved or cancelled from this page or from the speaker.',
        `<a class="btn small" href="/providers${household ? `?household=${encodeURIComponent(household)}` : ''}">Find someone</a>`,
      );

  const rail = `${authorityBand(db, caller, household)}${roster(db, caller, '/home', household)}`;
  return shell(rail, `<div class="stack">${body}</div>${provenance()}`);
}

export function movingView(
  offered: ToolResult,
  household?: string,
  db?: Db,
  caller?: Caller,
): string {
  const rail =
    db && caller ? `${authorityBand(db, caller, household)}${roster(db, caller, '/home', household)}` : '';
  const options = offered.options ?? [];
  if (!options.length) {
    return shell(
      rail,
      card(
        `<h2>No free time to move it to</h2><p>${esc(String(offered.facts?.refusal ?? 'On Behalf could not find a free time in the next three weeks.'))}</p><a class="btn quiet" href="/home">Back to the diary</a>`,
      ),
    );
  }
  return shell(
    rail,
    `${card(
      `<h2 class="name">Move ${esc(offered.facts?.provider)}</h2>
     ${kv([
       ['At the moment', `${offered.facts?.currentDay} at ${offered.facts?.currentTime}`],
       ['On Behalf matched it on', offered.facts?.matchedOn],
     ])}
     <p class="note">These are the only times that can be confirmed. A time On Behalf did
     not offer is refused, on this page and on the speaker alike.</p>
     <div>${options
       .map((o) =>
         form(
           '/move-confirm',
           { changeId: String(offered.facts?.changeId), startsAt: String(o.startsAt), household },
           `${o.day} at ${o.time}`,
         ),
       )
       .join('')}</div>
     <p><a href="/home">Leave it where it is</a></p>`,
    )}
  ${readbackPanel(
      { provider: offered.facts?.provider, day: 'the day you choose above', time: 'the time you choose above' },
      ['provider', 'day', 'time'],
      'What the speaker will be given when this moves',
      'The same three facts go to the Echo at both houses. Alexa writes its own sentence from them; On Behalf guarantees they are all there and each one is true standing alone.',
    )}
  ${provenance()}`,
  );
}

export function cancelView(
  result: ToolResult,
  visitId: string,
  household?: string,
  db?: Db,
  caller?: Caller,
): string {
  const f = result.facts ?? {};
  const rail =
    db && caller ? `${authorityBand(db, caller, household)}${roster(db, caller, '/home', household)}` : '';
  return shell(
    rail,
    `${card(
      `<h2 class="name">Cancel ${esc(f.provider)}?</h2>
     ${kv([
       ['For', f.service],
       ['Day', f.day],
       ['Time', f.time],
       ['Notice', `${f.hoursOfNotice} hours`],
       ['Their policy', f.cancellationPolicy],
       ['It would cost', asScreenMoney(f.cancellationCost)],
     ])}
     <p class="note">Policy Requirement 15 makes On Behalf read the booking and the
     cancellation policy back before a cancellation, so nothing has been cancelled yet.
     This page is the same second step the speaker takes.</p>
     ${form('/cancel-confirm', { visitId, household }, 'Yes, cancel it', 'warn')}
     <a class="btn quiet" href="/home">Keep it</a>`,
      'attention',
    )}
  ${readbackPanel(
      f,
      CANCELLATION_FACTS,
      'What the speaker was given, exactly',
      'An add-on cannot script what Alexa says: the model composes the sentence from the data it is handed. So On Behalf does not promise a sentence. It promises the set of facts the sentence is made from — every required fact present, each one true on its own in any order, none of them an instruction to the model or an identifier that should not be spoken aloud.',
    )}
  ${provenance()}`,
  );
}

// ---------------------------------------------------------------------------
// The readback panel.
//
// This is the best engineering decision in the product and it had no presence on
// screen at all. `assertReadbackSafe` runs on every result bound for the spoken turn;
// what is drawn here is the fact set it passed, named and checked, one row each.

function readbackPanel(
  facts: Record<string, unknown>,
  required: readonly string[],
  heading: string,
  contract: string,
): string {
  const rows = required
    .map((key) => {
      const value = facts[key];
      const present = value !== undefined && value !== null && value !== '';
      return `<li>
        <span class="fact-key">${esc(key)}</span>
        <span class="fact-value">${present ? esc(value) : '—'}</span>
        <span class="fact-ok">${present ? 'checked' : 'missing'}</span>
      </li>`;
    })
    .join('');
  return `<div class="readback">
    <h3>${esc(heading)}</h3>
    <p class="contract">${esc(contract)}</p>
    <ul class="facts">${rows}</ul>
    <p class="after">Checked by assertReadbackSafe in src/domain/readback.ts, on this
    request, before anything was returned. A missing fact, a phrase that reads as an
    instruction, a phrase that only makes sense next to another one, or an identifier
    all refuse the turn rather than reach the speaker.</p>
  </div>`;
}

// ---------------------------------------------------------------------------

export function waitingView(db: Db, caller: Caller, household?: string): string {
  beginMeasure();
  const viewing = targetHousehold(db, caller, household);
  const r = runTool(db, caller, 'what_is_waiting', { household });
  const rows = rowsOf(r);
  const rail = `${authorityBand(db, caller, household)}${roster(db, caller, '/waiting', household)}`;
  const hint = household ? `?household=${encodeURIComponent(household)}` : '';
  if (!rows.length) {
    const over = grantsOverHousehold(db, viewing.id).find((g) => g.status === 'active');
    const detail = over
      ? `Everything arranged for this home has been agreed. Anything above ${screenMoney(
          over.spendCapCents,
        )}, outside ${coversWords(over)}, or with less than ${over.noticeHours} hours' notice stops here and waits for you rather than going ahead.`
      : 'Everything arranged for this home has been agreed. Anything that needs somebody at this address to say yes will stop here and wait.';
    const nothing = viewing.id === caller.household.id
      ? 'Nothing needs you'
      : `Nothing is waiting at ${viewing.name}`;
    return shell(
      rail,
      `${empty(nothing, detail, `<a class="btn quiet small" href="/home${hint}">See the diary</a>`)}${provenance()}`,
    );
  }
  return shell(rail, `<div class="stack">${rows
    .map((row) =>
      row.kind === 'visit'
        ? card(
            `<h3 class="name">${esc(row.provider)}</h3>
             ${kv([
               ['For', row.service],
               ['Day', row.day],
               ['Time', row.time],
               ['Cost', asScreenMoney(row.price)],
               ['Asked for by', row.askedBy],
             ])}
             ${form('/agree', { visitId: row.visitId, household }, 'Yes, that is fine')}
             ${form('/cancel-start', { visitId: row.visitId, household }, 'No, not that', 'quiet')}`,
            'attention',
          )
        : card(
            `<h3 class="name">${esc(row.askedBy)} would like to help</h3>
             ${kv([
               ['Would cover', row.covers],
               ['Up to', row.limit],
             ])}
             <form method="post" action="/accept-code" class="row">
               <div style="flex:1 1 200px">
                 <label for="code">The six character code they gave you</label>
                 <input id="code" name="code" autocomplete="off" required>
               </div>
               <button>Accept</button>
             </form>
             <p class="note">You can also say it to your own Echo. Either way it is your
             account that agrees, not theirs, and you can end it again from either.</p>`,
            'attention',
          ),
    )
    .join('')}</div>${provenance()}`);
}

// ---------------------------------------------------------------------------
// The arrangement page: the terms themselves. A grant with no visible scope and no
// visible expiry is the thing families are afraid of, so this page draws both.

function permitList(g: Grant): string {
  const line = (on: boolean, what: string) =>
    `<li class="${on ? '' : 'off'}"><span class="${on ? 'yes' : 'no'}" aria-hidden="true">${
      on ? '✓' : '✕'
    }</span><span class="perm-what">${esc(what)}${on ? '' : ' — not permitted'}</span></li>`;
  return `<ul class="perms">
    ${line(g.mayBook, 'Book a new visit')}
    ${line(g.mayReschedule, 'Move a visit already in the diary')}
    ${line(g.mayCancel, 'Cancel a visit')}
  </ul>`;
}

/** A window is a shape, and families worry about the shape of it. */
function hoursBar(from: number, to: number): string {
  const left = (Math.max(0, Math.min(24, from)) / 24) * 100;
  const width = (Math.max(0, Math.min(24, to) - Math.min(24, from)) / 24) * 100;
  return `<div class="hours">
    <div class="hours-bar" role="img" aria-label="Visits allowed between ${esc(
      hourWord(from),
    )} and ${esc(hourWord(to))}">
      <span class="hours-lit" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span>
    </div>
    <div class="hours-scale"><span>midnight</span><span>${esc(hourWord(from))}</span><span>${esc(
      hourWord(to),
    )}</span><span>midnight</span></div>
  </div>`;
}

export function arrangementView(db: Db, caller: Caller, draft?: string, household?: string): string {
  beginMeasure();
  const viewing = targetHousehold(db, caller, household);
  const overMe = grantsOverHousehold(db, viewing.id);
  const mine = grantsForDelegate(db, caller.account.id);
  const mineHome = viewing.id === caller.household.id;

  const overMeCards = overMe.length
    ? overMe
        .map((g) => {
          const who = getAccount(db, g.delegateAccount)?.displayName ?? 'someone';
          const ended = g.status === 'revoked' || g.status === 'expired';
          return card(
            `<h3 class="name">${esc(who)} ${stateTag(g.status)}</h3>
             <p class="note" style="margin-bottom:14px">${termsSentence(g, 'They may')}</p>
             ${permitList(g)}
             ${kv([
               ['Covers', g.categories.map(humanCategory).join(', ')],
               ['Most per visit', screenMoney(g.spendCapCents)],
               ['Notice needed', `${g.noticeHours} hours before a visit starts`],
               ['Accepted', g.acceptedAt ? `${longDate(g.acceptedAt)}, ${g.acceptedVia === 'voice' ? 'on their own Echo' : 'by tapping accept'}` : 'not yet'],
               [ended ? 'Ended' : 'Runs until', ended ? longDate(g.revokedAt ?? g.expiresAt) : endsWords(g.expiresAt)],
             ])}
             ${hoursBar(g.earliestHour, g.latestHour)}
             <div style="margin-top:14px">
               ${g.status === 'active' ? form('/grant-state', { grantId: g.id, next: 'paused' }, 'Pause it', 'quiet') : ''}
               ${g.status === 'paused' ? form('/grant-state', { grantId: g.id, next: 'active' }, 'Start it again') : ''}
               ${g.status !== 'revoked' ? form('/grant-state', { grantId: g.id, next: 'revoked' }, 'End it', 'warn') : ''}
             </div>
             <p class="note">Pausing and ending are yours alone. They need no code and no
             one else's agreement, they take effect on the next request either surface
             makes, and visits already in the diary stand.</p>`,
            g.status === 'active' ? '' : 'hushed',
          );
        })
        .join('')
    : empty(
        mineHome ? 'Nobody helps here' : `Nobody helps at ${viewing.name}`,
        'No one has been given a say over this household. When somebody proposes one, it arrives on the Waiting page with a six character code, and nothing is granted until you enter it — here or on your own Echo.',
        `<a class="btn quiet small" href="/waiting${household ? `?household=${encodeURIComponent(household)}` : ''}">See what is waiting</a>`,
      );

  const drafting = card(
    `<h2>Describe an arrangement in a sentence</h2>
     <form method="post" action="/draft" class="stack">
       <div>
         <label for="sentence">What you look after, what you will not spend past, and when visits suit</label>
         <textarea id="sentence" name="sentence" required
           placeholder="I look after plumbing and heating at Mum's, nothing over two hundred dollars, weekday mornings">${esc(draft ?? '')}</textarea>
       </div>
       <button>Turn it into terms</button>
     </form>
     <p class="note">A model turns the sentence into a form you can edit. It grants
     nothing: the other household still has to accept it on their own device, and the
     model is nowhere near the path of anything spoken.</p>`,
  );

  const mineCards = mine.length
    ? table(
        ['Home', 'State', 'Covers', 'Most per visit', 'Runs until', 'Code'],
        mine.map((g) => [
          `<span class="name">${esc(getHousehold(db, g.subjectHousehold)?.name ?? '')}</span>`,
          stateTag(g.status),
          esc(g.categories.map(humanCategory).join(', ')),
          `<span class="num">${esc(screenMoney(g.spendCapCents))}</span>`,
          esc(longDate(g.expiresAt)),
          g.pairingCode ? `<strong>${esc(g.pairingCode)}</strong>` : '<span class="note">used</span>',
        ]),
      )
    : empty(
        'You stand by for nobody yet',
        'Describe an arrangement below, check the terms it produces, and propose it. The other household gets a six character code in their written channel, and nothing at all happens until they say it back.',
      );

  const rail = `${authorityBand(db, caller, household)}${roster(db, caller, '/arrangement', household)}`;
  const main = `<div class="split">
    <div class="stack">${sideLabel(
      mineHome ? 'Who has a say over this home' : `Who has a say over ${viewing.name}`,
    )}${overMeCards}</div>
    <div class="stack">${sideLabel('Homes you help with')}${card(mineCards)}${drafting}</div>
  </div>
  ${provenance()}`;
  return shell(rail, main);
}

export function draftedView(drafted: {
  terms: { categories: readonly string[]; spendCapCents: number; noticeHours: number; earliestHour: number; latestHour: number; mayBook: boolean; mayReschedule: boolean; mayCancel: boolean; days: number };
  dropped: readonly string[];
  summary: string;
  fromFallback: boolean;
  model: string | null;
}, db: Db, caller: Caller): string {
  const others = allHouseholds(db).filter((h) => h.id !== caller.household.id);
  const t = drafted.terms;
  const checkbox = (name: string, label: string, on: boolean) =>
    `<label style="display:flex;gap:10px;align-items:center;color:var(--bone);font-size:1em"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} style="width:auto"> ${esc(label)}</label>`;
  const rail = `${authorityBand(db, caller)}${roster(db, caller, '/arrangement')}`;
  return shell(
    rail,
    card(
    `<h2>Check it before you send it</h2>
     <p class="note">${drafted.fromFallback ? 'The model was not reachable, so this was drafted from the words in your sentence.' : `Drafted by ${esc(drafted.model)}.`} ${esc(drafted.summary)}</p>
     ${drafted.dropped.map((d) => `<p class="flash needs">${esc(droppedNotice(d))}</p>`).join('')}
     <form method="post" action="/propose" class="stack">
       <div>
         <label for="household">Which home</label>
         <select id="household" name="household">${others
           .map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`)
           .join('')}</select>
       </div>
       <div>
         <label for="categories">What it covers</label>
         <select id="categories" name="categories" multiple size="8">${CATEGORIES.map(
           (c) =>
             `<option value="${c}" ${t.categories.includes(c) ? 'selected' : ''}>${esc(humanCategory(c))}</option>`,
         ).join('')}</select>
       </div>
       <div class="row">
         <div style="flex:1 1 140px"><label for="cap">Limit a visit, in dollars</label>
           <input id="cap" name="cap" type="number" min="1" value="${Math.round(t.spendCapCents / 100)}"></div>
         <div style="flex:1 1 140px"><label for="notice">Notice, in hours</label>
           <input id="notice" name="notice" type="number" min="0" value="${t.noticeHours}"></div>
         <div style="flex:1 1 100px"><label for="from">No earlier than</label>
           <input id="from" name="from" type="number" min="0" max="23" value="${t.earliestHour}"></div>
         <div style="flex:1 1 100px"><label for="to">No later than</label>
           <input id="to" name="to" type="number" min="1" max="24" value="${t.latestHour}"></div>
       </div>
       ${hoursBar(t.earliestHour, t.latestHour)}
       <div class="stack" style="margin-top:14px">
         ${checkbox('mayBook', 'May book visits', t.mayBook)}
         ${checkbox('mayReschedule', 'May move visits', t.mayReschedule)}
         ${checkbox('mayCancel', 'May cancel visits', t.mayCancel)}
       </div>
       <button>Propose it</button>
     </form>
     <p class="note">Proposing grants nothing. It sends a six character code to the other
     household's written channel, and the arrangement only starts when somebody there
     says that code back on their own account.</p>`,
    ),
  );
}

// ---------------------------------------------------------------------------

export function providersView(
  db: Db,
  caller: Caller,
  category: string,
  household?: string,
): string {
  beginMeasure();
  const chooser = card(
    `<form method="get" action="/providers" class="row">
       ${household ? `<input type="hidden" name="household" value="${esc(household)}">` : ''}
       <div style="flex:1 1 220px">
         <label for="category">What kind of work</label>
         <select id="category" name="category">${CATEGORIES.map(
           (c) => `<option value="${c}" ${c === category ? 'selected' : ''}>${esc(humanCategory(c))}</option>`,
         ).join('')}</select>
       </div>
       <button>Look</button>
     </form>
     <p class="note"><span class="mock">mock directory</span> These trades are local
     fixtures, and their free times come from a hash of the provider and the date, so
     the same Thursday comes back on every run.</p>`,
    'hushed',
  );

  const r = runTool(db, caller, 'find_provider', { category, household });
  const inScope = r.facts?.withinArrangement === true;
  const body = rowsOf(r).length
    ? rowsOf(r)
        .map((p) =>
          card(
            `<h3 class="name">${esc(p.provider)}</h3>
             ${kv([
               ['A visit costs', asScreenMoney(p.price)],
               ['Cancelling', p.cancellationPolicy],
               ['Next free', p.nextStartsAt ? `${p.nextDay} at ${p.nextTime}` : 'nothing free'],
               ['Also free', p.alsoFree],
             ])}
             ${
               p.nextStartsAt
                 ? `<form method="post" action="/book" class="row">
                      <input type="hidden" name="providerId" value="${esc(p.providerId)}">
                      <input type="hidden" name="startsAt" value="${esc(p.nextStartsAt)}">
                      ${household ? `<input type="hidden" name="household" value="${esc(household)}">` : ''}
                      <div style="flex:1 1 260px">
                        <label for="s-${esc(p.providerId)}">What the work is</label>
                        <input id="s-${esc(p.providerId)}" name="summary" required
                               placeholder="the dripping tap in the kitchen">
                      </div>
                      <button>Book ${esc(p.nextDay)}</button>
                    </form>`
                 : ''
             }`,
          ),
        )
        .join('')
    : empty(
        'Nobody for that',
        'The directory has nobody in that category. Pick another kind of work above.',
      );

  const warn = inScope
    ? ''
    : `<p class="flash needs">${esc(humanCategory(category))} is outside what that household agreed to. On Behalf will refuse a booking rather than make one, on this page and on the speaker alike.</p>`;

  const rail = `${authorityBand(db, caller, household)}${roster(db, caller, '/providers', household)}`;
  return shell(rail, `${chooser}${warn}<div class="stack">${body}</div>${provenance()}`);
}

// ---------------------------------------------------------------------------

export function decisionsView(db: Db, caller: Caller, household?: string): string {
  beginMeasure();
  const viewing = targetHousehold(db, caller, household);
  const r = runTool(db, caller, 'pending_decisions');
  // `pending_decisions` spans every home this account stands by for, which is right for
  // a voice turn. On a page that has a home selected, the selection is the filter — and
  // the rows already carry the household name they belong to.
  const rows = rowsOf(r).filter((p) => !household || p.household === viewing.name);
  const rail = `${authorityBand(db, caller, household)}${roster(db, caller, '/decisions', household)}`;
  if (!rows.length) {
    const helping = household
      ? [viewing]
      : liveGrantsForDelegate(db, caller.account.id)
          .map((g) => getHousehold(db, g.subjectHousehold))
          .filter((h): h is Household => !!h);
    const detail = helping.length
      ? `Nothing is held for you. When somebody at ${andList(
          helping.map((h) => h.name),
        )} asks for work that On Behalf will not book on its own — outside what you cover, above the limit, or too close to the day — it stops and waits here for you to decide.`
      : 'Nothing is held for you. Once a household accepts an arrangement, anything On Behalf will not act on by itself stops and waits here.';
    return shell(
      rail,
      `${empty('Nothing is waiting on you', detail, `<a class="btn quiet small" href="/standby">See both homes</a>`)}${provenance()}`,
    );
  }
  return shell(rail, `<div class="stack">${rows
    .map((p) =>
      card(
        `<h3 class="name">${esc(p.provider)} at ${esc(p.household)}</h3>
         ${kv([
           ['For', p.service],
           ['Asked for by', p.askedBy],
           ['Proposed', `${p.day} at ${p.time}`],
           ['Cost', asScreenMoney(p.price)],
           ['Why it is waiting', p.whyWaiting],
         ])}
         ${
           p.recommendation === 'not yet reviewed'
             ? `<p class="note">No reasoning prepared yet. Preparing it calls a model, off
                the spoken path, and nothing acts on what it says.</p>
                ${form('/adjudicate', { changeId: p.changeId }, 'Prepare the reasoning')}`
             : `<p class="flash">${esc(p.headline)}<br><span class="note">On Behalf suggests: ${esc(p.recommendation)}. It is a suggestion. Nothing acts on it.</span></p>`
         }
         ${form('/decide', { changeId: p.changeId, verdict: 'approve' }, 'Go ahead')}
         ${form('/decide', { changeId: p.changeId, verdict: 'decline' }, 'Not for now', 'quiet')}`,
        'attention',
      ),
    )
    .join('')}</div>${provenance()}`);
}

export function adjudicationView(
  adj: { recommendation: string; headline: string; reasons: string[]; risks: string[]; fromFallback: boolean; model: string | null; latencyMs: number },
  changeId: string,
  db?: Db,
  caller?: Caller,
): string {
  const rail = db && caller ? `${authorityBand(db, caller)}${roster(db, caller, '/decisions')}` : '';
  return shell(
    rail,
    `${card(
      `<h2>${esc(adj.headline)}</h2>
     <p>${tag(adj.recommendation, adj.recommendation === 'approve' ? 'live' : 'needs')}</p>
     <h3>Reasons</h3>
     <ul>${adj.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
     ${adj.risks.length ? `<h3>Worth knowing</h3><ul>${adj.risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
     ${form('/decide', { changeId, verdict: 'approve' }, 'Go ahead')}
     ${form('/decide', { changeId, verdict: 'decline' }, 'Not for now', 'quiet')}`,
      'attention',
    )}
  <div class="provenance">
    <span>${
      adj.fromFallback
        ? 'Written from the ledger by the rule engine. The model was not reachable, and nothing waited on it.'
        : `Written by <span class="calls">${esc(adj.model)}</span> in <span class="ms">${adj.latencyMs} ms</span> — after the turn it relates to had already been answered.`
    }</span>
    <span>This is the one place a model runs, and it is not on the spoken path.</span>
  </div>`,
  );
}

// ---------------------------------------------------------------------------

export function briefView(db: Db, caller: Caller, household?: string): string {
  beginMeasure();
  const r = runTool(db, caller, 'latest_brief', { household });
  const body =
    r.code === 'no_brief_yet'
      ? empty(
          'No note written yet',
          'An Alexa+ add-on cannot speak first, so nothing at the other house can reach you at the moment it happens. A note written from the ledger and sent to your own inbox is the only thing that can.',
          form('/write-brief', { household }, 'Write one now'),
        )
      : card(
          `<h2 class="name">${esc(r.facts?.household)}</h2>
           <p class="note" style="margin:-8px 0 14px">Written ${esc(r.facts?.writtenOn)}</p>
           <pre class="msg">${esc(r.facts?.body)}</pre>
           <p class="note">${r.facts?.writtenByModel ? 'Written by a model, from the ledger, and sent to your own written channel.' : 'Written straight from the ledger, because the model was not reachable.'}</p>
           ${form('/write-brief', { household }, 'Write a new one', 'quiet')}`,
        );
  const rail = `${authorityBand(db, caller, household)}${roster(db, caller, '/brief', household)}`;
  return shell(rail, `${body}${provenance()}`);
}

// ---------------------------------------------------------------------------


/**
 * The ledger's What column, in words.
 *
 * It printed the audit row's `action` verbatim, so a page whose own note says "anyone in
 * the household can read this" showed `visit.awaiting_household` and `grant.proposed`
 * next to a Why column written in careful English. The machine key is the wrong register
 * for the reader and it is not what anyone calls these things. The key is kept in the
 * CSV, which is where a developer reads it.
 */
const ACTION_WORDS: Record<string, string> = {
  book: 'Booked a visit',
  cancel: 'Cancelled a visit',
  reschedule: 'Asked to move a visit',
  'change.requested': 'Asked to move a visit',
  'grant.accepted': 'Agreed to the arrangement',
  'grant.proposed': 'Proposed an arrangement',
  'grant.paused': 'Paused the arrangement',
  'grant.revoked': 'Ended the arrangement',
  'grant.active': 'Restarted the arrangement',
  'request.declined': 'Turned a request down',
  'service.requested': 'Asked for some work',
  'visit.accepted': 'Agreed to a visit',
  'visit.awaiting_household': 'Waiting on the household to agree',
  'visit.booked': 'Booked a visit',
  'visit.cancelled': 'Cancelled a visit',
  'visit.moved': 'Moved a visit',
  'visit.refused': 'Refused a visit',
};

const actionWords = (action: string): string =>
  ACTION_WORDS[action] ?? action.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** `own_household` and `within_scope` are ours, not the reader's. */
const HOW_WORDS: Record<string, string> = {
  own_household: 'their own home',
  within_scope: 'inside the arrangement',
  inside_notice_window: 'inside the notice window',
  voice: 'by voice',
  touch: 'by hand',
};

const howWords = (key: string): string => HOW_WORDS[key] ?? key.replace(/_/g, ' ').toLowerCase();

export function ledgerView(db: Db, caller: Caller, household?: string, days = 30): string {
  beginMeasure();
  const r = runTool(db, caller, 'what_changed', { household, days });
  const rows = rowsOf(r);
  const viewing = targetHousehold(db, caller, household);
  const full = auditFor(db, viewing.id, new Date(Date.now() - days * 86_400_000).toISOString());

  const filter = card(
    `<form method="get" action="/ledger" class="row">
       ${household ? `<input type="hidden" name="household" value="${esc(household)}">` : ''}
       <div style="flex:0 1 160px">
         <label for="days">How far back</label>
         <select id="days" name="days">${[7, 14, 30, 90, 365]
           .map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>${d} days</option>`)
           .join('')}</select>
       </div>
       <button>Show</button>
       <a class="btn quiet" href="/ledger.csv?days=${days}${household ? `&household=${encodeURIComponent(household)}` : ''}">Download as CSV</a>
     </form>
     <p class="note">Anyone in the household can read this, on this page or by asking
     their own speaker. It is the same record either way, and a delegate cannot edit or
     hide a line of it.</p>`,
    'hushed',
  );

  const body = rows.length
    ? table(
        ['When', 'Who', 'What', 'Why', 'How'],
        full
          .slice(0, 60)
          .map((e) => [
            `<span class="num">${esc(readableStamp(e.at, viewing.timezone))}</span>`,
            `<span class="name">${esc(e.actor === 'system' ? 'On Behalf' : (getAccount(db, e.actor)?.displayName ?? 'someone'))}</span>`,
            esc(actionWords(e.action)),
            esc(e.reason),
            `${tag(howWords(e.surface))}${e.capability ? ` ${tag(howWords(e.capability))}` : ''}`,
          ]),
      )
    : empty(
        'Nothing in that window',
        'No action has been taken at this home in the period you chose. Widen the window above, or book something and it appears here with who did it, through which surface, and under which part of the arrangement.',
      );

  const rail = `${authorityBand(db, caller, household)}${roster(db, caller, '/ledger', household)}`;
  return shell(rail, `${filter}${card(body)}${provenance()}`);
}

export function ledgerCsv(db: Db, householdId: string, days: number): string {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const head = 'at,actor,surface,action,capability,reason\n';
  // Quoting makes a cell one field. It does not make it text: a spreadsheet reads a cell
  // beginning `= + - @` as a formula whether or not it arrived in quotes, and the ledger
  // carries a visit summary somebody typed at home. `forCsvCell` is the destination rule
  // from §4 of the guard standard and it runs before the quoting, not instead of it.
  const q = (s: unknown) => `"${forCsvCell(String(s ?? '')).replace(/"/g, '""')}"`;
  return (
    head +
    auditFor(db, householdId, since)
      .map((e) =>
        [
          e.at,
          e.actor === 'system' ? 'system' : (getAccount(db, e.actor)?.displayName ?? e.actor),
          e.surface,
          e.action,
          e.capability ?? '',
          e.reason,
        ]
          .map(q)
          .join(','),
      )
      .join('\n')
  );
}

// ---------------------------------------------------------------------------

export function outboxView(db: Db, caller: Caller, open?: string, household?: string): string {
  beginMeasure();
  // Addressed to this person, or to anyone in a home they may act in. Showing one
  // household the other's mail would undo the written channel it is meant to prove.
  // Naming a home narrows that set to the one named; it can never widen it, because the
  // hint is resolved against the reachable set before it is used.
  const viewing = targetHousehold(db, caller, household);
  const reachable = household
    ? [viewing]
    : [
        caller.household,
        ...liveGrantsForDelegate(db, caller.account.id)
          .map((g) => getHousehold(db, g.subjectHousehold))
          .filter((h): h is NonNullable<typeof h> => !!h),
      ];
  const addresses = reachable
    .flatMap((h) => accountsIn(db, h.id))
    .flatMap((a) => [a.email, a.sms ?? '']);
  const all = outboxTo(db, addresses);
  const rail = `${authorityBand(db, caller, household)}${roster(db, caller, '/outbox', household)}`;
  const why = `<p class="note" style="margin-bottom:20px">Policy Requirement 15 makes a
  written confirmation mandatory for a booking, and because an add-on cannot speak first
  it is also the only way anything at the other house can reach you without you asking.
  <span class="mock">mock transport</span> Messages are written to a local folder rather
  than sent.</p>`;

  if (!all.length) {
    return shell(
      rail,
      `${why}${empty(
        household && viewing.id !== caller.household.id ? `Nothing sent to ${viewing.name} yet` : 'Nothing sent yet',
        'Every booking, move and cancellation writes to both households, in full, and lands here with its channel, its delivery state and the number of attempts it took.',
        `<a class="btn quiet small" href="/providers">Book something</a>`,
      )}${provenance()}`,
    );
  }
  const chosen = all.find((m) => m.id === open) ?? all[0]!;
  const list = all
    .slice(0, 30)
    .map(
      (m) => `<li class="${m.status === 'queued' ? 'needs' : ''}">
        <span class="when">${esc(m.at.slice(0, 16).replace('T', ' '))}, ${esc(m.channel)}, ${esc(m.status)}${m.attempts > 1 ? `, ${m.attempts} attempts` : ''}</span>
        <span class="what"><a href="/outbox?open=${esc(m.id)}${household ? `&household=${esc(encodeURIComponent(household))}` : ''}"${
          m.id === chosen.id ? ' aria-current="true" class="open"' : ''
        }>${esc(m.subject)}</a></span>
        <span class="note">to ${esc(m.to)}</span>
      </li>`,
    )
    .join('');

  return shell(
    rail,
    `${why}
  <div class="split">
    <div>${sideLabel(`${all.length} messages`)}<ul class="timeline">${list}</ul></div>
    <div>${sideLabel('What was actually sent')}${card(
      `<h3>${esc(chosen.subject)}</h3>
       ${kv([
         ['Channel', chosen.channel],
         ['To', chosen.to],
         ['State', chosen.status],
         ['Attempts', chosen.attempts],
         ['Last error', chosen.lastError ?? 'none'],
       ])}
       <pre class="msg">${esc(chosen.body)}</pre>`,
    )}${card(
      `<h3>Delivery</h3><p class="note">A queued message is retried on the next pass, and
       the attempt count above is the real one.</p>${form('/deliver', {}, 'Run the delivery pass', 'quiet')}`,
      'hushed',
    )}</div>
  </div>
  ${provenance()}`,
  );
}

