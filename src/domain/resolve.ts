// Working out which visit somebody meant.
//
// "Move Thursday" is the sentence this product exists for, and it is ambiguous in
// three different ways at once: which Thursday, which of the things on it, and whether
// move means later that day or a different day entirely.
//
// No model runs here, for two reasons. The first is the round-trip budget: the MCP
// Toolkit wants under 500 ms and a model call cannot promise that. The second is
// better. When a request genuinely matches two visits, the right answer is not a guess
// with a confidence score, it is to hand Alexa both candidates and let it ask. A
// deterministic resolver that returns "these two" is a better voice experience than a
// clever one that returns the wrong one quickly.

import type { Db } from '../db.ts';
import type { Household, Visit } from '../types.ts';
import { getProvider, upcomingVisits } from './store.ts';
import { dayName, nowIso, parseDayName } from '../clock.ts';
import { humanCategory } from './capability.ts';

export type Match = 'one' | 'several' | 'none';

export interface Resolution {
  match: Match;
  candidates: Visit[];
  /** What in the phrase actually selected these, for the ledger and the console. */
  matchedOn: string[];
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'my',
  'our',
  'move',
  'change',
  'shift',
  'reschedule',
  'cancel',
  'visit',
  'appointment',
  'booking',
  'is',
  'on',
  'at',
  'for',
  'to',
  'i',
  'need',
  'want',
  'please',
  'coming',
  'come',
  'next',
  'this',
  'that',
  'guy',
  'man',
  'person',
  'someone',
  'it',
  'them',
  'one',
]);

/**
 * Whole-word stem matching, in both directions.
 *
 * "plumber" has to find "plumbing" and "gardener" has to find "gardening", because
 * people name the trade and the diary names the work. Plain substring matching does
 * that but also lets "it" find "kitchen", which is how a resolver starts moving the
 * wrong appointment.
 */
function wordsMatch(term: string, word: string): boolean {
  if (term === word) return true;
  if (term.length < 4 || word.length < 4) return false;
  const a = term.slice(0, 5);
  const b = word.slice(0, 5);
  return a === b || word.startsWith(a) || term.startsWith(b);
}

function words(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
}

/**
 * Score a visit against the phrase. A weekday match and a name match are worth the
 * same, because "Thursday" and "the plumber" are equally good ways of saying it.
 */
function score(
  db: Db,
  visit: Visit,
  terms: string[],
  house: Household,
): { score: number; on: string[] } {
  const provider = getProvider(db, visit.providerId);
  const haystack = [
    visit.summary.toLowerCase(),
    humanCategory(visit.category).toLowerCase(),
    visit.category.replace(/_/g, ' '),
    provider?.name.toLowerCase() ?? '',
    visit.reference.toLowerCase(),
  ]
    .join(' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const day = dayName(visit.startsAt, house.timezone).toLowerCase();

  let s = 0;
  const on: string[] = [];
  for (const t of terms) {
    if (t === day) {
      s += 2;
      on.push(`the day, ${dayName(visit.startsAt, house.timezone)}`);
      continue;
    }
    if (parseDayName(t)) continue; // a different weekday: no credit, no penalty
    if (haystack.some((w) => wordsMatch(t, w))) {
      s += 2;
      on.push(t);
    }
  }
  return { score: s, on };
}

export function resolveVisit(
  db: Db,
  house: Household,
  phrase: string,
  fromIso = nowIso(),
): Resolution {
  const upcoming = upcomingVisits(db, house.id, fromIso);
  if (upcoming.length === 0) return { match: 'none', candidates: [], matchedOn: [] };

  const terms = words(phrase);
  if (terms.length === 0) {
    // "Move it" with nothing else, and exactly one thing in the diary, is unambiguous.
    return upcoming.length === 1
      ? { match: 'one', candidates: upcoming, matchedOn: ['the only visit in the diary'] }
      : { match: 'several', candidates: upcoming.slice(0, 4), matchedOn: [] };
  }

  const scored = upcoming
    .map((v) => ({ visit: v, ...score(db, v, terms, house) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.visit.startsAt.localeCompare(b.visit.startsAt));

  if (scored.length === 0) return { match: 'none', candidates: [], matchedOn: [] };

  const top = scored[0]!.score;
  const tied = scored.filter((r) => r.score === top);
  if (tied.length === 1) {
    return { match: 'one', candidates: [tied[0]!.visit], matchedOn: tied[0]!.on };
  }
  return {
    match: 'several',
    candidates: tied.slice(0, 4).map((r) => r.visit),
    matchedOn: tied[0]!.on,
  };
}

/** The weekday a phrase names, if it names one. Used to aim the slot search. */
export function weekdayIn(phrase: string): number | undefined {
  for (const w of phrase.toLowerCase().split(/\s+/)) {
    const d = parseDayName(w.replace(/[^a-z]/g, ''));
    if (d) {
      return [
        'Sunday',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
      ].indexOf(d);
    }
  }
  return undefined;
}
