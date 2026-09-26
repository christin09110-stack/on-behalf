// The console's stylesheet, served as one file.
//
// Second pass. The first pass treated Cutaway as a structural hint only and
// kept a bespoke dark pine/kingfisher
// theme with a serif for names. Told directly that the before and after looked
// the same — which was the proof it hadn't followed the reference — this pass
// throws that palette and that type system out and takes Cutaway's actual values:
// its light ground, its orange, its greys, its Inter/JetBrains Mono stack, its
// card and button and table shapes. Where Standby needs something Cutaway has no
// screen for (the authority band, the household roster), it is built from
// Cutaway's own components — the panel, the pill, the chip, the left-accent
// callout — rather than invented fresh.
//
// ---------------------------------------------------------------------------
// The shell.
//
// Cutaway: `.app{display:grid;grid-template-columns:212px 1fr}`, a sticky
// `.side` and a `.main` holding a `.top` bar (breadcrumb + avatar) above a
// padded `.body`. Standby's shell is the same grid, the same sticky rail, the
// same top bar. The one measured deviation is the rail's width: Cutaway's 212px
// holds a wordmark, one button and four nav labels; Standby's also has to hold
// the authority sentence ("You are acting for Marian at Ridgeway... may book and
// move plumbing, heating..., up to 200 dollars a visit... until 4 March") and a
// household roster, neither of which exists in Cutaway at all. 212px wraps that
// sentence into a ladder of one or two words a line; 220px — Inter is narrower
// than the previous pass's serif at the same size, so the gap needed is small —
// wraps it into three or four ordinary short lines instead. Recorded here and in
// SPEC.md as the one deliberate deviation, not a miss.
//
// Two colours carry meaning beyond decoration, same as Cutaway's own restraint
// (accent doubles as "weak episode" and as the agent-console error colour there —
// one hue, two jobs, rather than a fresh one for every state):
//
//   --accent (Cutaway's own #F2571B) is the brand colour, every primary action,
//   and the active nav / active roster row.
//
//   --gold (Cutaway's own "interrogation" swatch, #C99A22 — an actual value from
//   their file, not invented) is the one warm signal reserved for "you are
//   acting inside somebody else's home" and "something is waiting on you". nothing
//   else in the interface is that colour, so warmth keeps meaning only those two
//   things, same rule as the pass before, now in Cutaway's own gold rather than a
//   bespoke wheat.
//
//   --danger is the one token this file adds that Cutaway's file has no need of:
//   a destructive-action red. Cutaway has no delete or revoke button anywhere in
//   it. Standby's whole product is delegated power, and ending an arrangement in
//   one press from wherever you are is the point, so it needs a colour Cutaway
//   never had to choose. Picked at the same lightness and saturation register as
//   their own gold and green, so it reads as part of the family rather than a
//   third style arriving from nowhere.

import {
  interRegular,
  interMedium,
  interSemiBold,
  interBold,
  jetbrainsMonoRegular,
  jetbrainsMonoMedium,
} from './font-data.ts';

const face = (
  family: string,
  weight: number,
  style: 'normal' | 'italic',
  data: string,
): string => `
@font-face {
  font-family: '${family}';
  font-weight: ${weight};
  font-style: ${style};
  font-display: swap;
  src: url(data:font/woff2;base64,${data}) format('woff2');
}`;

const FONT_FACES = [
  face('Inter', 400, 'normal', interRegular),
  face('Inter', 500, 'normal', interMedium),
  face('Inter', 600, 'normal', interSemiBold),
  face('Inter', 700, 'normal', interBold),
  face('JetBrains Mono', 400, 'normal', jetbrainsMonoRegular),
  face('JetBrains Mono', 500, 'normal', jetbrainsMonoMedium),
].join('\n');

export const CSS = `
${FONT_FACES}

:root {
  /* Cutaway's own root values (agentic-cinema/cutaway/web/app.css), taken as-is. */
  --page: #FAFAFA;
  --card: #FFFFFF;
  --ink: #141414;
  --muted: #8A8A8A;
  --line: #E7E7E7;
  --line-soft: #F1F1F1;
  --accent: #F2571B;
  --tint: #FDF0EB;
  --hold: #2C6E9B;
  --gold: #C99A22;      /* Cutaway's "interrogation" category colour */
  --gold-tint: #FBF2DC;  /* --gold, tinted the same way Cutaway tints --accent into --tint */
  --live: #2FA36B;       /* Cutaway's own connection-dot colour, .dot.on in their app.css */
  --danger: #C0392B;     /* not Cutaway's — see header comment */

  --radius: 7px;
  --radius-lg: 9px;

  /* rem, not px. A px body size overrides the reader's own browser/OS text-size
     setting, which is the control an older person is most likely to have already
     found and turned up. Everything below is sized in em against this. */
  --text: 1rem;
  --t-xs: 0.75em;
  --t-sm: 0.8125em;
  --t-lg: 1.15em;
  --t-xl: 1.4em;
  --t-2xl: 1.7em;

  /* Cutaway's rail is 212px; ours carries a sentence, not a label. See header. */
  --rail: 220px;

  --sans: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

html { background: var(--page); }

body {
  margin: 0;
  font-family: var(--sans);
  font-size: var(--text);
  line-height: 1.5;
  color: var(--ink);
  background: var(--page);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

/* Larger still, on top of whatever the browser is already set to. Chosen by the
   person rather than by the route: the parent who needs it needs it on the
   ledger too, not only on the two pages we guessed. Remembered in a cookie. */
body.big { --text: 1.3125rem; line-height: 1.6; }
body.big .card { padding: 24px; }
body.big button, body.big .btn { min-height: 62px; }
body.big .roster-row { padding: 14px; }

a { color: var(--hold); text-decoration: none; }
a:hover { text-decoration: underline; }

/* One name, one place — the same narrow rule as before, now expressed in weight
   rather than a second typeface, because Cutaway names exactly one family. */
.serif, h1, .band-lead, .roster-home, .empty strong, .name {
  font-family: var(--sans);
  font-weight: 700;
  letter-spacing: -0.01em;
}

h1 { font-size: var(--t-2xl); line-height: 1.2; margin: 0 0 4px; font-weight: 700; }
h2 { font-size: var(--t-lg); font-weight: 650; margin: 0 0 12px; letter-spacing: -0.005em; }
h3 { font-size: 1em; font-weight: 650; margin: 0 0 8px; }
h3.name, h2.name { font-weight: 700; font-size: var(--t-lg); }

/* ---- the shell: Cutaway's grid, '.app{212px 1fr}', ---------------------- */

.page { background: var(--page); }

.shell {
  display: grid;
  grid-template-columns: var(--rail) 1fr;
  align-items: start;
  max-width: 1360px;
  margin: 0 auto;
  min-height: 100vh;
}

/* ---- the rail -----------------------------------------------------------
   Cutaway: 'position:sticky;top:0;height:100vh'. Standby's rail routinely runs
   taller than 100vh once the authority band and household roster are in it, and
   a height cap with its own overflow scroll would silently turn the account
   footer ("switch account", the text-size toggle) into an undiscoverable second
   scroll region — found by screenshot in the first pass, not by a test. So the
   height cap is dropped: the rail is exactly as tall as its content, stays
   pinned while there is page left to scroll past, and scrolls with the page once
   there isn't. Every link stays reachable by the one scroll gesture in use. */
.side {
  border-right: 1px solid var(--line);
  padding: 18px 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  position: sticky;
  top: 0;
  min-height: 100vh;
}

.side-brand { display: flex; align-items: center; gap: 9px; padding: 2px 0 0; }
.side-brand .word {
  font-size: 1.2em;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
  line-height: 1;
}

/* ---- rail navigation, Cutaway's '.nav button' as a link ----------------- */

.rail-nav { display: flex; flex-direction: column; gap: 2px; }
.rail-nav a {
  display: block;
  padding: 9px 12px;
  border-radius: var(--radius);
  color: var(--ink);
  font-size: var(--t-sm);
  font-weight: 500;
}
.rail-nav a:hover { background: #F4F4F4; text-decoration: none; }
.rail-nav a[aria-current="page"] { background: var(--tint); color: var(--accent); font-weight: 600; }
.rail-nav .group-label {
  color: var(--muted);
  font-size: 0.75em;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  margin: 10px 0 2px 12px;
}
.rail-nav .records a { color: var(--muted); }

/* ---- the account at the foot of the rail, Cutaway's '.side footer' ------ */

.side-foot { margin-top: auto; padding-top: 14px; border-top: 1px solid var(--line); }
.side-foot .who { font-size: var(--t-xs); color: var(--muted); line-height: 1.4; }
.side-foot .who strong {
  display: block;
  color: var(--ink);
  font-weight: 700;
  font-size: 1.15em;
  margin-bottom: 1px;
}
.side-foot .who .signout { color: var(--muted); }
.side-foot .signin a { color: var(--accent); font-weight: 600; }

.textsize { display: flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 2px; margin-top: 10px; width: fit-content; }
.textsize form { display: inline; }
.textsize button {
  min-height: 26px;
  padding: 3px 12px;
  font-size: var(--t-xs);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  border: 0;
  font-weight: 600;
}
.textsize button:hover { color: var(--ink); filter: none; }
.textsize button[aria-pressed='true'] { background: var(--accent); color: #fff; }

/* ---- the main column: Cutaway's '.top' + '.body' ------------------------ */

.main { display: flex; flex-direction: column; min-width: 0; }

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 26px;
  border-bottom: 1px solid var(--line);
}
.crumb { color: var(--muted); font-size: var(--t-sm); }
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #EFEFEF;
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
  font-size: 0.75em;
  font-weight: 700;
  color: var(--muted);
  flex: none;
}

.body { padding: 20px 26px 34px; display: flex; flex-direction: column; gap: 18px; }

.title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.title-row .lede { color: var(--muted); font-size: var(--t-sm); max-width: 62ch; margin: 0; }

/* ---- the household roster: the spine of the product -------------------- */
/*
   Every household this console will show you, one row each, in the rail on
   every signed-in screen. Each row switches the page you are already on to
   that household rather than a fixed landing page.

   Drawn in the shape of Cutaway's '.ep' boxes — a small bordered card, the
   current one picked out with an accent border and tint background exactly the
   way Cutaway marks '.ep[aria-current="true"]' — rather than the deep-set rows
   the previous pass invented.
*/
.roster { display: flex; flex-direction: column; gap: 8px; margin: 0; }
.roster-row {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--card);
  padding: 10px 11px;
}
.roster-row.is-paused, .roster-row.is-revoked, .roster-row.is-expired { opacity: 0.72; }
.roster-row.is-proposed { border-color: #EAD9A6; background: var(--gold-tint); }
.roster-row.is-current { border-color: var(--accent); background: var(--tint); }
.roster-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.roster-home { font-size: 1em; line-height: 1.2; color: var(--ink); }
.roster-row.is-current .roster-home { color: var(--accent); }
.roster-whose { font-size: var(--t-xs); color: var(--muted); display: block; margin-top: 1px; }
.roster-summary { font-size: var(--t-xs); color: var(--muted); margin-top: 5px; line-height: 1.4; }
.roster-act { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 6px; }
.roster-act form { margin: 0; }
.roster-act button, .roster-act .btn { min-height: 30px; padding: 4px 10px; font-size: var(--t-xs); }

/* ---- the authority band: Cutaway's '.intent' box, carrying more ---------
   The one loud element, and it is loud about the one thing this product is
   for: who is acting, in whose home, what that permits, when it stops, and the
   button that stops it now. Cutaway's '.intent' is a white card with a 3px
   accent left border and an uppercase accent label — this is that shape, at
   rail width, warmed to gold when the account looking at the screen is acting
   inside somebody else's home (the second and only other job warmth has here).
*/

.band-auth {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 13px 14px 12px 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
}
.band-auth.acting { border-color: #EAD9A6; border-left-color: var(--gold); background: var(--gold-tint); }

.band-mark { display: block; flex: none; }

.band-lead { font-size: 1em; line-height: 1.3; margin: 0; color: var(--ink); }
.band-lead .band-home { color: var(--accent); }
.band-auth.acting .band-lead .band-home { color: var(--gold); }

.band-scope { font-size: var(--t-xs); color: #454545; margin: 0; line-height: 1.5; }
.band-scope strong { color: var(--ink); font-weight: 600; }
.band-scope .ends { color: var(--ink); font-weight: 600; }
.band-note { font-size: var(--t-xs); color: var(--muted); margin: 0; line-height: 1.5; }
.band-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; width: 100%; }
.band-actions form { margin: 0; }
.band-actions .band-aside { font-size: var(--t-xs); color: var(--muted); }

/* ---- layout -------------------------------------------------------------- */

.split { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
.stack > * + * { margin-top: 16px; }

/* Cutaway's '.panel': white card, hairline border, 9px radius. */
.card {
  position: relative;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 18px 20px;
}
.card.attention { border-color: #EAD9A6; border-left: 3px solid var(--gold); background: var(--gold-tint); }
.card.hushed { background: transparent; border-style: dashed; }

.side-label {
  color: var(--muted);
  font-size: 0.72em;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  margin-bottom: 10px;
}

.rule { height: 1px; background: var(--line); border: 0; margin: 24px 0; }

/* ---- the timeline that hangs off a card ---------------------------------- */

.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { position: relative; padding: 12px 0 12px 22px; border-bottom: 1px solid var(--line-soft); }
.timeline li:last-child { border-bottom: 0; padding-bottom: 0; }
.timeline li::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 21px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line);
  border: 1px solid #CCC;
}
.timeline li.needs::before { background: var(--gold); border-color: var(--gold); }
.timeline a.open { color: var(--ink); font-weight: 600; }
.timeline a.open::after { content: ' \\2190 shown'; color: var(--muted); font-weight: 400; font-size: var(--t-xs); }
.timeline li .when { color: var(--muted); font-size: var(--t-sm); }
.timeline li .what { display: block; }
.timeline li .note { display: block; }

/* ---- pieces --------------------------------------------------------------- */

.kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 18px; margin: 0; }
.kv dt { color: var(--muted); font-size: var(--t-sm); padding-top: 1px; }
.kv dd { margin: 0; }

/* Cutaway's '.chip' (outline) for a plain tag, '.pill' (solid) for a state. */
.tag {
  display: inline-block;
  font-size: var(--t-xs);
  letter-spacing: 0.01em;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--card);
  color: #3C3C3C;
  font-weight: 600;
  vertical-align: 0.1em;
}
.tag.live { color: #fff; border-color: var(--live); background: var(--live); }
.tag.needs { color: #fff; border-color: var(--gold); background: var(--gold); }
.tag.off { color: var(--muted); border-color: var(--line); background: var(--page); }

/* Cutaway's '.primary': accent fill, 7px radius, 600 weight, brightness hover. */
button, .btn {
  font: inherit;
  display: inline-block;
  min-height: 44px;
  padding: 10px 18px;
  border-radius: var(--radius);
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
}
button:hover, .btn:hover { filter: brightness(1.06); text-decoration: none; }
button.quiet, .btn.quiet { background: var(--card); color: var(--ink); border-color: var(--line); }
button.quiet:hover, .btn.quiet:hover { border-color: #C9C9C9; filter: none; background: #FAFAFA; }
/* The destructive verb, and only the verb — see header comment on --danger. */
button.warn { background: var(--card); border-color: var(--danger); color: var(--danger); }
button.warn:hover { background: var(--danger); color: #fff; filter: none; }
button.small, .btn.small { min-height: 36px; padding: 6px 14px; font-size: var(--t-sm); }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 3px solid var(--gold);
  outline-offset: 2px;
}
button:disabled { opacity: 0.55; cursor: default; filter: none; }

form.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
form.row > div { max-width: 380px; }
label { display: block; font-size: var(--t-sm); color: var(--muted); margin-bottom: 5px; }
input, select, textarea {
  font: inherit;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 12px;
  width: 100%;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
input::placeholder { color: #ABABAB; }
textarea { min-height: 88px; resize: vertical; }

/* Cutaway's table: uppercase muted headers, hairline rows. */
table { width: 100%; position: relative; border-collapse: collapse; font-size: var(--t-sm); }
th, td { text-align: left; padding: 9px 10px 9px 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 0.7em; letter-spacing: 0.08em; text-transform: uppercase; border-bottom-color: var(--line); }
tr:last-child td { border-bottom: 0; }
td.num, th.num { font-variant-numeric: tabular-nums; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }

.note { color: var(--muted); font-size: var(--t-sm); max-width: 72ch; }
.mock {
  display: inline-block;
  font-size: var(--t-xs);
  color: var(--gold);
  border: 1px dashed #D9C078;
  border-radius: 999px;
  padding: 1px 9px;
  font-weight: 600;
}
pre.msg {
  white-space: pre-wrap;
  font-family: var(--mono);
  font-size: var(--t-sm);
  line-height: 1.6;
  background: #FBFBFB;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 15px;
  margin: 0;
  color: #2E3B47;
}

/* ---- empty states --------------------------------------------------------- */

.empty {
  position: relative;
  border: 1px solid var(--line);
  border-left: 3px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 22px 24px;
  color: var(--muted);
  background: var(--card);
}
.empty strong { display: block; color: var(--ink); font-size: var(--t-lg); margin-bottom: 7px; }
.empty p { margin: 0; max-width: 62ch; }
.empty .empty-act { margin-top: 15px; }
.empty .empty-act form { margin: 0 8px 0 0; }

.flash {
  position: relative;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  background: var(--tint);
  padding: 12px 16px;
  border-radius: var(--radius);
  margin-bottom: 4px;
  max-width: 88ch;
}
.flash.bad { border-left-color: var(--danger); background: #FBEAE7; }
.flash.needs { border-left-color: var(--gold); background: var(--gold-tint); }

/* ---- the readback panel --------------------------------------------------- */
/*
   Alexa composes its own sentence and an add-on cannot script it. What Standby
   can guarantee is the set of facts the sentence is composed from — drawn as
   Cutaway's '.intent' box: white panel, accent left rule, uppercase accent
   label, and the mono treatment Cutaway reserves for its own SQL and tool names.
*/
.readback { border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--card); padding: 17px 19px; }
.readback h3 { color: var(--accent); margin-bottom: 4px; }
.readback .contract { font-size: var(--t-sm); color: var(--muted); margin: 0 0 14px; max-width: 70ch; }
.facts { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.facts li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 14px; align-items: baseline; padding: 9px 13px; background: var(--card); }
.facts .fact-key { color: var(--muted); font-size: var(--t-sm); font-family: var(--mono); }
.facts .fact-value { color: var(--ink); }
.facts .fact-ok { color: var(--live); font-size: var(--t-xs); white-space: nowrap; font-weight: 600; }
.readback .after { font-size: var(--t-xs); color: var(--muted); margin: 12px 0 0; max-width: 70ch; }

/* ---- the permitted-hours bar ----------------------------------------------- */

.hours { margin: 4px 0 0; }
.hours-bar {
  position: relative;
  height: 12px;
  border-radius: 3px;
  background: repeating-linear-gradient(90deg, var(--card) 0 1px, transparent 1px 100%) #F0F0F0;
  border: 1px solid var(--line);
  overflow: hidden;
}
.hours-lit { position: absolute; top: 0; bottom: 0; background: var(--accent); }
.hours-scale { display: flex; justify-content: space-between; font-size: var(--t-xs); color: var(--muted); margin-top: 3px; }

/* ---- what a grant permits, drawn as permissions --------------------------- */

.perms { list-style: none; margin: 0; padding: 0; }
.perms li { display: grid; grid-template-columns: 1.7em minmax(0, 1fr); gap: 4px; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--line-soft); }
.perms li:last-child { border-bottom: 0; }
.perms .yes { color: var(--live); font-weight: 700; }
.perms .no { color: var(--muted); font-weight: 700; }
.perms li.off .perm-what { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--line); }

/* ---- provenance: the tool, its time, and no model, in Cutaway's mono ------ */

.provenance {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px 22px;
  margin: 26px 0 0;
  padding: 11px 0 0;
  border-top: 1px solid var(--line);
  font-size: var(--t-xs);
  color: var(--muted);
}
.provenance .calls { color: #3C3C3C; font-family: var(--mono); }
.provenance .ms { color: var(--accent); font-family: var(--mono); font-weight: 600; font-variant-numeric: tabular-nums; }
.provenance .model-off { color: var(--muted); }

/* ---- the claims strip ------------------------------------------------------ */

footer.foot { border-top: 1px solid var(--line); margin-top: 8px; padding: 22px 26px 50px; max-width: 1360px; margin-left: auto; margin-right: auto; }
.claims { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; list-style: none; margin: 0; padding: 0; }
.claims li { padding: 0 22px; border-left: 1px solid var(--line); }
.claims li:first-child { padding-left: 0; border-left: 0; }
.claims .claim { display: block; color: var(--ink); font-size: 0.9em; margin-bottom: 5px; }
.claims .proof { color: var(--muted); font-size: var(--t-xs); font-family: var(--mono); }

/* ---- narrow ---------------------------------------------------------------
   Below 860px there isn't room for a fixed rail beside a readable content
   column, so the shell drops to one column: the rail stops being sticky and
   becomes an ordinary block above the content, in document order. Nothing in
   it becomes unreachable — it is still every link and every form, just
   stacked instead of pinned. */
@media (max-width: 860px) {
  .shell { display: block; }
  .side {
    position: static;
    min-height: 0;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    width: 100%;
    padding: 16px 16px 18px;
    gap: 14px;
  }
  .rail-nav { flex-direction: row; flex-wrap: wrap; gap: 4px 6px; }
  .rail-nav a { padding: 7px 13px; border-radius: 999px; }
  .rail-nav .group-label { width: 100%; margin: 6px 0 0 2px; }
  .roster { flex-direction: row; flex-wrap: wrap; }
  .roster-row { flex: 1 1 220px; }
  .top, .body { padding-left: 16px; padding-right: 16px; }
  .split { grid-template-columns: 1fr; gap: 24px; }
  .claims { grid-template-columns: 1fr 1fr; gap: 18px 0; padding-left: 16px; padding-right: 16px; }
  .claims li:nth-child(3) { padding-left: 0; border-left: 0; }
  footer.foot { padding-left: 0; padding-right: 0; }
}

@media (max-width: 720px) {
  .claims { grid-template-columns: 1fr; gap: 16px; }
  .claims li { padding-left: 0; border-left: 0; }
  .facts li { grid-template-columns: minmax(0, 1fr) auto; }
  .facts .fact-key { grid-column: 1 / -1; }
}

/* Five columns do not fit a phone. Each row becomes a card and each cell says
   which column it came from, so nothing is off the right-hand edge. */
@media (max-width: 720px) {
  table, tbody, tr, td { display: block; width: 100%; }
  thead {
    position: absolute;
    left: 0;
    top: 0;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  table { position: relative; }
  thead tr, thead th { display: block; width: 1px; height: 1px; overflow: hidden; padding: 0; border: 0; }
  tr { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin: 0 0 12px; }
  tbody tr:last-child { margin-bottom: 0; }
  td { border-bottom: 0; padding: 6px 0; }
  td + td { border-top: 1px solid var(--line-soft); }
  td::before {
    content: attr(data-label);
    display: block;
    color: var(--muted);
    font-size: var(--t-xs);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: 3px;
  }
}

@media (max-width: 560px) {
  .top, .body { padding-left: 16px; padding-right: 16px; }
  h1 { font-size: 1.5em; }
  .provenance { flex-direction: column; }
  .roster { flex-direction: column; }
  .roster-row { flex: 1 1 auto; }
}

@media (prefers-reduced-motion: no-preference) {
  .card, .rail-nav a, button, .btn { transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease; }
}
`;
