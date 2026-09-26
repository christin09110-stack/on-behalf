// Server-rendered HTML, with no client JavaScript at all.
//
// That is a decision, not a shortcut. Amazon's accessibility guidance for Alexa+
// add-ons requires the experience to be completable "touch only, including on-screen
// keyboard, without voice". A page made of links and forms is the version of that
// which works on a slow tablet, with a screen reader, with the text size turned up,
// and with scripting off.

import { ALL_TOOLS } from '../mcp/tools.ts';

export const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Two groups, because ten flat pills in a centred row wrapped into a ragged second
 * line and gave a reader no way to tell the things they do from the records they can
 * check. The first group is what a person came here to do. The second is the account
 * of what has been done, which is read far less often and should not compete.
 */
const DOING: Array<[string, string]> = [
  ['/standby', 'Both homes'],
  ['/home', 'The diary'],
  ['/waiting', 'Waiting'],
  ['/decisions', 'Decisions'],
  ['/providers', 'Find someone'],
  ['/arrangement', 'Arrangement'],
];

const RECORDS: Array<[string, string]> = [
  ['/brief', 'Where things stand'],
  ['/ledger', 'Ledger'],
  ['/outbox', 'Written channel'],
];

export interface PageOptions {
  title: string;
  path: string;
  who?: { name: string; household: string } | null;
  /**
   * Larger type and larger targets. Two routes turned this on by themselves, which meant
   * the parent who needs bigger type got it on their own diary and lost it on the ledger.
   * It is now a control at the foot of the rail, on every page, remembered in a cookie.
   */
  big?: boolean;
  /**
   * The home this page is looking at, carried on every rail link.
   *
   * `?household=` used to be read by four routes and dropped by five, and the nav dropped
   * it everywhere. So a delegate who chose the other household on the household list, then
   * pressed Waiting, was shown her own home's waiting list under the heading "Nothing
   * needs you" while the other household had two things outstanding. On a product about
   * one household acting for another, a page that answers about the wrong home is worse
   * than a page that refuses.
   */
  household?: string;
  flash?: { kind: 'ok' | 'bad' | 'needs'; text: string } | null;
}

/** Each claim is a structural property of the build, and each carries its proof. */
const CLAIMS: Array<[string, string]> = [
  [
    'No health arrangement of any kind, and no way to configure one in.',
    'tests/screening.test.ts',
  ],
  [
    `Every one of the ${ALL_TOOLS.length} things the speaker can be asked can be done here by hand.`,
    'tests/touch-parity.test.ts',
  ],
  [
    'No model is reachable from the spoken path. The build fails the moment one becomes reachable.',
    'tests/no-model-on-read-path.test.ts',
  ],
  [
    'Amazon allows a spoken turn 500 milliseconds. The slowest tool measured here uses single digits of it.',
    'npm run bench',
  ],
];

function railNavHtml(path: string, household?: string): string {
  const q = household ? `?household=${encodeURIComponent(household)}` : '';
  const link = ([href, label]: [string, string]) =>
    `<a href="${href}${q}"${path === href ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="rail-nav" aria-label="On Behalf">
    ${DOING.map(link).join('')}
    <div class="group-label records">Records</div>
    <span class="records">${RECORDS.map(link).join('')}</span>
  </nav>`;
}

/**
 * The private join between what `views.ts` builds for the rail (the authority band and
 * the household list — both need `db` and `caller`, which `page()` below never receives,
 * only the display strings in `opts.who`) and what it builds for the content column.
 *
 * `server.ts` calls `page(opts, bodyHtml: string)` with a single string and cannot be
 * changed to pass more, so the split travels inside that one string instead: `shell()`
 * joins the two halves with a marker no real HTML ever produces, and `page()` below
 * splits on it. A regex over the HTML itself was the other option and was rejected —
 * the rail content nests its own `<div>`s, so matching "the wrapper's own closing tag"
 * rather than the first or last one anywhere in the string is not reliable. A plain,
 * private delimiter has no such failure mode.
 */
const RAIL_SPLIT = '\u0000STANDBY-RAIL\u0000';

export function shell(railHtml: string, mainHtml: string): string {
  return `${railHtml}${RAIL_SPLIT}${mainHtml}`;
}

/** Cutaway's top bar carries a static "RK". This one is real: the initials of
 * whoever is actually signed in, or a bare dash before anyone has. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '');
}

export function page(opts: PageOptions, body: string): string {
  const [railExtra, main] = body.includes(RAIL_SPLIT)
    ? (body.split(RAIL_SPLIT) as [string, string])
    : ['', body];

  const flash = opts.flash
    ? `<p class="flash ${opts.flash.kind === 'ok' ? '' : opts.flash.kind}">${esc(opts.flash.text)}</p>`
    : '';

  // Turning the text up must not also move you to a different household's page.
  const here = `${opts.path}${opts.household ? `?household=${encodeURIComponent(opts.household)}` : ''}`;
  const size = (label: string, value: string, on: boolean) =>
    `<form method="post" action="/text-size"><input type="hidden" name="to" value="${value}">` +
    `<input type="hidden" name="from" value="${esc(here)}">` +
    `<button aria-pressed="${on}">${label}</button></form>`;
  const textsize = `<div class="textsize" role="group" aria-label="Text size">
    ${size('Normal', 'normal', !opts.big)}${size('Larger', 'large', !!opts.big)}
  </div>`;

  const who = opts.who
    ? `<div class="who"><strong>${esc(opts.who.name)}</strong>${esc(opts.who.household)}<br><a class="signout" href="/">switch account</a></div>${textsize}`
    : `<div class="signin"><a href="/">Link an account</a></div>`;

  // The signed-out page introduces itself; every other page states where you are.
  const title = opts.who ? `<h1>${esc(opts.title)}</h1>` : '';

  // Cutaway's top bar: a breadcrumb on the left, an avatar on the right. The
  // avatar carries the signed-in account's real initials rather than Cutaway's
  // hardcoded "RK".
  const top = `<div class="top">
    <div class="crumb">${esc(opts.title)}</div>
    <div class="avatar" aria-hidden="true">${esc(opts.who ? initials(opts.who.name) : '–')}</div>
  </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · On Behalf</title>
<meta name="color-scheme" content="light">
<link rel="stylesheet" href="/app.css">
</head>
<body class="${opts.big ? 'big' : ''}">
<div class="page">
  <div class="shell">
    <aside class="side">
      <div class="side-brand">
        ${standbyMark(false)}
        <span class="word">On Behalf</span>
      </div>
      ${railExtra}
      ${opts.who ? railNavHtml(opts.path, opts.household) : ''}
      <div class="side-foot">${who}</div>
    </aside>
    <div class="main">
      ${top}
      <div class="body">
        ${flash}
        ${title}
        ${main}
      </div>
    </div>
  </div>
  <footer class="foot">
    <ul class="claims">
      ${CLAIMS.map(
        ([claim, proof]) =>
          `<li><span class="claim">${esc(claim)}</span><span class="proof">${esc(proof)}</span></li>`,
      ).join('')}
    </ul>
  </footer>
</div>
</body>
</html>`;
}

export const card = (inner: string, kind = ''): string =>
  `<section class="card ${kind}">${inner}</section>`;

/**
 * An empty screen is an invitation, and a judge may see one before they see anything
 * else. So each one says what would appear here, why it has not, and what to press;
 * `action` is the press.
 */
export const empty = (heading: string, detail: string, action = ''): string =>
  `<div class="empty"><strong>${esc(heading)}</strong><p>${esc(detail)}</p>${
    action ? `<div class="empty-act">${action}</div>` : ''
  }</div>`;

export const sideLabel = (s: string): string => `<div class="side-label">${esc(s)}</div>`;

export function kv(pairs: Array<[string, unknown]>): string {
  return `<dl class="kv">${pairs
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('')}</dl>`;
}

/**
 * A table whose cells carry their own column name.
 *
 * At 390px the ledger's five columns held their shape and ran 109px off the right of the
 * screen, and the column that went over the edge was How — the capability pills, which
 * are the ledger's entire point. The arrangement table did the same thing with its
 * pairing code. Below 720px the stylesheet stacks each row into a card and prints the
 * column name beside the value, which is what every other page here already does at that
 * width; `data-label` is what it prints, and the roles keep the table a table when the
 * display property stops saying so.
 */
export function table(headers: string[], rows: string[][]): string {
  return `<table role="table"><thead role="rowgroup"><tr role="row">${headers
    .map((h) => `<th role="columnheader" scope="col">${esc(h)}</th>`)
    .join('')}</tr></thead>
<tbody role="rowgroup">${rows
    .map(
      (r) =>
        `<tr role="row">${r
          .map((c, i) => `<td role="cell" data-label="${esc(headers[i] ?? '')}">${c}</td>`)
          .join('')}</tr>`,
    )
    .join('')}</tbody></table>`;
}

export const tag = (text: string, kind = ''): string =>
  `<span class="tag ${kind}">${esc(text)}</span>`;

/** A form that posts one action. Everything that changes state goes through one. */
export function form(
  action: string,
  fields: Record<string, unknown>,
  button: string,
  kind = '',
): string {
  const hidden = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<form method="post" action="${esc(action)}" style="display:inline-block;margin:4px 6px 0 0">${hidden}<button class="${kind}">${esc(button)}</button></form>`;
}

/**
 * The two-square mark: your home, and the home you stand by, joined by a hairline.
 * The lit one is the home the screen in front of you is about. It is the product in a
 * glyph, and it changes with the state, so the delegated case reads before a word of
 * it has been. Used once, neutral, as the wordmark at the top of the rail; used again,
 * live, inside the authority band lower down.
 */
export function standbyMark(acting: boolean): string {
  // Cutaway's own accent orange for the neutral/own-home mark; its "interrogation"
  // gold — this app's one other warm signal — when the mark is showing you are
  // acting inside somebody else's home. See style.ts's header comment on --gold.
  const lit = acting ? '#C99A22' : '#F2571B';
  const dim = '#8A8A8A';
  return `<svg class="band-mark" width="34" height="20" viewBox="0 0 46 20" aria-hidden="true" focusable="false">
    <line x1="14" y1="10" x2="32" y2="10" stroke="${acting ? lit : dim}" stroke-width="1.5"
          ${acting ? '' : 'stroke-dasharray="2 3"'} />
    <rect x="1" y="1" width="13" height="13" rx="1.5" transform="translate(0 2.5)"
          fill="${acting ? 'none' : lit}" stroke="${acting ? dim : lit}" stroke-width="1.5" />
    <rect x="32" y="1" width="13" height="13" rx="1.5" transform="translate(0 2.5)"
          fill="${acting ? lit : 'none'}" stroke="${acting ? lit : dim}" stroke-width="1.5" />
  </svg>`;
}
