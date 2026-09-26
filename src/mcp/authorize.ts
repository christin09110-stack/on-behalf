// The authorisation chokepoint.
//
// Standby is a product about one household administering another household's affairs, so
// an authorisation hole here is not a hardening detail: it is the premise failing. A
// review found that `authorize(` appeared zero times anywhere under `src/mcp/`. The
// capability engine was real, it was well tested, and it sat on four write paths inside
// `src/domain/`. Every read tool, and every tool that takes a record id instead of a
// household name, reached the database without it.
//
// Two things followed from that, both reproduced by running them:
//
//   * A grant whose `expiresAt` had passed still read the other household's diary and
//     its audit ledger. `authorize()` refuses an expired grant on the very next line
//     after `grant_revoked`, and nothing called `authorize()`.
//   * A *revoked* grant still named the other household, its terms and the date of its
//     next visit through `list_on_behalf_households`, because that tool read
//     `grantsForDelegate` — every row, of every status.
//
// The fix is one gate, not a check per tool. Every tool declares, as data, which
// household the call is about and which action it is: `subject(db, caller, args)`. The
// field is required on `ToolDef`, so a tool that does not declare it does not compile,
// and `tests/authorisation.test.ts` walks the registry and proves each one is behind the
// gate rather than trusting that it is.
//
// What the gate does NOT do is decide holds. A hold means "somebody at the other house
// has to agree", and composing that needs the price, the hour and the notice window,
// which belong to the domain functions that already do it. The gate asks the narrowest
// true question — may this caller act in this house at all, in this manner — and refuses
// on `deny`. `allow` and `hold` both pass through to the domain, which then does the
// full job. Two gates disagreeing would be worse than one gate.

import type { Db } from '../db.ts';
import type { Household } from '../types.ts';
import type { Caller } from './auth.ts';
import type { Action, Decision } from '../domain/capability.ts';
import { authorize } from '../domain/capability.ts';
import {
  getChange,
  getHousehold,
  getVisit,
  grantBetween,
  liveGrantsForDelegate,
} from '../domain/store.ts';
import { StandbyError } from '../domain/grants.ts';

/** What a call is about: one household, and one thing being done to it. */
export interface ToolSubject {
  household: Household;
  action: Action;
}

/**
 * Every tool declares one of these. It may throw `StandbyError` when the record named in
 * the arguments does not exist, which is the same refusal the domain function would have
 * produced one layer down.
 */
export type SubjectResolver = (
  db: Db,
  caller: Caller,
  args: Record<string, unknown>,
) => ToolSubject;

/**
 * Which household a turn is about, chosen only from the ones this caller may reach.
 *
 * With no hint it is the caller's own, which is the common case and the one the older
 * relative will always hit. A delegate naming a house gets a loose match on the name,
 * because they will say "Mum's" or "Ridgeway" and not an identifier.
 *
 * The reachable set is built **before** anything is looked up, and it is the only thing
 * searched. That ordering is the fix for a real hole: this function used to try
 * `getHousehold(db, hint)` first and return whatever came back, so any caller who knew
 * or guessed a household id got that household, and every read tool that calls this
 * consumed the result without a further check. Below it, a last-resort substring search
 * ran over `allHouseholds`, which would hand back a stranger's home for the word "the".
 *
 * A home that exists but is not reachable and a home that does not exist give the same
 * answer on purpose: the difference is not the caller's to learn.
 *
 * Reachability is not authorisation. This function answers "is this house in the set I
 * am allowed to name", and `authorizeCall` below answers "and may I do this to it". The
 * expired grant walked through here because reachability was all anybody asked.
 */
export function targetHousehold(db: Db, caller: Caller, hint?: unknown): Household {
  if (!hint || typeof hint !== 'string' || !hint.trim()) return caller.household;
  const needle = hint.trim().toLowerCase();

  const reachable = [
    caller.household,
    ...liveGrantsForDelegate(db, caller.account.id)
      .map((g) => getHousehold(db, g.subjectHousehold))
      .filter((h): h is Household => !!h),
  ];

  const hit =
    reachable.find((h) => h.id === hint.trim()) ??
    reachable.find((h) => h.name.toLowerCase() === needle) ??
    reachable.find((h) => h.name.toLowerCase().includes(needle));

  if (!hit) {
    throw new StandbyError(
      'unknown_household',
      `On Behalf does not know a home called ${hint} that you can act in.`,
    );
  }
  return hit;
}

/** The household a visit sits in. Refuses rather than guessing when it is not found. */
export function householdOfVisit(db: Db, visitId: unknown): Household {
  const visit = getVisit(db, String(visitId ?? ''));
  if (!visit) throw new StandbyError('unknown_visit', 'On Behalf has no visit with that number.');
  const house = getHousehold(db, visit.householdId);
  if (!house) throw new StandbyError('unknown_visit', 'On Behalf has no visit with that number.');
  return house;
}

/** The household a change request belongs to, through its visit. */
export function householdOfChange(db: Db, changeId: unknown): Household {
  const change = getChange(db, String(changeId ?? ''));
  if (!change) {
    throw new StandbyError('unknown_change', 'On Behalf has no request with that number.');
  }
  return householdOfVisit(db, change.visitId);
}

/** Shorthand for the many tools whose subject is a household name and a read. */
export const readsHousehold =
  (action: Action = 'read'): SubjectResolver =>
  (db, caller, args) => ({ household: targetHousehold(db, caller, args.household), action });

/** Shorthand for a tool that acts only on the caller's own home. */
export const ownHousehold =
  (action: Action = 'read'): SubjectResolver =>
  (_db, caller) => ({ household: caller.household, action });

/**
 * The gate. Throws `StandbyError` carrying the capability engine's own code and its
 * user-facing sentence, which is what the MCP server and the console already render.
 *
 * The reason is the engine's — app-authored, written for the household, and containing
 * nothing anybody typed or any model wrote. §6 of the guard standard: whatever the guard
 * refuses is output too, so the refusal must be safe to say out loud.
 */
export function authorizeCall(
  db: Db,
  caller: Caller,
  subject: SubjectResolver,
  args: Record<string, unknown>,
): Decision {
  const target = subject(db, caller, args);
  const decision = authorize({
    actor: caller.account,
    targetHousehold: target.household,
    action: target.action,
    grant: grantBetween(db, caller.account.id, target.household.id),
  });
  if (decision.verdict === 'deny') {
    throw new StandbyError(decision.code, decision.reason);
  }
  return decision;
}
