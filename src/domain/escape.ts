// Escaping for the destination, not in general.
//
// There is no such thing as sanitised text. There is text that is safe for *this*
// destination, and Standby has three that matter:
//
//   the voice line   Alexa's response is SSML underneath, so a `<` or an `&` in a stored
//                    string is markup in somebody's speaker. It is also unbounded, and a
//                    brief the model wrote is the one string on this path with no length
//                    the app chose.
//   the HTML page    handled by `esc()` in `src/web/html.ts`, which already escapes
//                    quotes; nothing here duplicates it.
//   the CSV ledger   `/ledger.csv` is opened in a spreadsheet, and a cell beginning
//                    `= + - @` is a formula there.
//
// The floor under all three is `stripControls`: before anything is stored, a model string
// loses C0/C1 controls, ANSI escapes, bidi controls and zero-width characters. Those have
// no meaning in any of the destinations above, so persisting them is only ever a way to
// carry an attack across a boundary the guard has already passed.

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-Z\\-_]|\u009B[0-?]*[ -/]*[@-~]/g;
// Keeps tab (09) and newline (0A); strips everything else in C0 and C1.
const CTRL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const INVISIBLE = /[­​‌‍⁠﻿‪-‮⁦-⁩]/g;

/**
 * The ingest floor. Run before persisting any model string.
 *
 * With `keepNewlines` false a newline becomes a space, never nothing. Deleting it would
 * weld the last word of one line to the first of the next, which is how "did not\ncome"
 * becomes a token no phrase rule matches.
 */
export function stripControls(s: string, keepNewlines = true): string {
  const flat = keepNewlines ? s : s.replace(/[\r\n]+/g, ' ');
  return flat.replace(ANSI, '').replace(CTRL, '').replace(INVISIBLE, '');
}

/**
 * The spoken channel. Alexa+ composes the sentence from the data Standby returns, and
 * that composition runs through SSML, so `<` and `&` are the two characters that stop
 * being text. The cap is here rather than at the call site because the brief is the one
 * string on this path whose length the app does not choose.
 */
export const VOICE_LIMIT = 1200;

export function forVoice(s: string, limit: number = VOICE_LIMIT): string {
  const flat = stripControls(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (flat.length <= limit) return flat;
  // Cut on a word boundary where there is one, so the last thing spoken is a word and
  // not half of an escape sequence.
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit - 120 ? cut.slice(0, space) : cut).trimEnd();
}

/** A spreadsheet reads a leading `= + - @` or tab as a formula. A quote makes it text. */
export function forCsvCell(s: string): string {
  const flat = stripControls(s, false).replace(/\r/g, ' ');
  return /^[=+\-@\t]/.test(flat) ? `'${flat}` : flat;
}
