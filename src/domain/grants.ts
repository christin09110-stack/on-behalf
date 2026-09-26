// Arranging, accepting and ending an arrangement between two households.
//
// The consent ceremony is the part worth reading. Alexa+ gives an add-on one linked
// account and no idea who is in the room, so Standby cannot ask "is that you, Mum?".
// What it can do is require the agreement to be completed on the other household's own
// account, on their own device: the delegate proposes, a code goes to the subject's
// written channel, and the arrangement only becomes real when a request carrying the
// subject household's own linked account says that code back, or somebody signed in as
// that account taps accept.
//
// The same is true in reverse and matters more: pausing and ending are available to
// the subject household alone, and need no code, no delegate and no app.

import type { Db } from '../db.ts';
import type { Account, Category, Grant, Household } from '../types.ts';
import {
  getAccount,
  accountsIn,
  getGrant,
  getHousehold,
  grantBetween,
  grantByCode,
  saveGrant,
  writeAudit,
} from './store.ts';
import { id, pairingCode } from '../ids.ts';
import { addDays, nowIso } from '../clock.ts';
import { queue } from './outbox.ts';
import { grantAccepted, grantEnded, grantProposed } from './messages.ts';
import { humanCategory } from './capability.ts';

export class StandbyError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StandbyError';
    this.code = code;
  }
}

export interface Terms {
  categories: Category[];
  spendCapCents: number;
  noticeHours: number;
  earliestHour: number;
  latestHour: number;
  mayBook: boolean;
  mayReschedule: boolean;
  mayCancel: boolean;
  days: number;
}

export const DEFAULT_TERMS: Terms = {
  categories: ['plumbing', 'heating', 'appliance_repair', 'gardening'],
  spendCapCents: 25_000,
  noticeHours: 24,
  earliestHour: 9,
  latestHour: 17,
  mayBook: true,
  mayReschedule: true,
  mayCancel: true,
  days: 365,
};

export function proposeGrant(
  db: Db,
  delegate: Account,
  subjectHousehold: Household,
  terms: Terms,
): Grant {
  const subjects = accountsIn(db, subjectHousehold.id);
  if (subjects.length === 0) {
    throw new StandbyError('no_subject_account', `${subjectHousehold.name} has no linked account.`);
  }
  const subject = subjects[0]!;
  const code = pairingCode();
  const g: Grant = {
    id: id('grant'),
    delegateAccount: delegate.id,
    subjectHousehold: subjectHousehold.id,
    subjectAccount: subject.id,
    status: 'proposed',
    categories: terms.categories,
    spendCapCents: terms.spendCapCents,
    noticeHours: terms.noticeHours,
    earliestHour: terms.earliestHour,
    latestHour: terms.latestHour,
    mayBook: terms.mayBook,
    mayReschedule: terms.mayReschedule,
    mayCancel: terms.mayCancel,
    proposedAt: nowIso(),
    acceptedAt: null,
    acceptedVia: null,
    expiresAt: addDays(nowIso(), terms.days),
    pairingCode: code,
    revokedAt: null,
    revokedBy: null,
  };
  saveGrant(db, g);
  queue(
    db,
    grantProposed({
      to: subject,
      house: subjectHousehold,
      delegate,
      code,
      categories: terms.categories,
      capCents: terms.spendCapCents,
    }),
  );
  writeAudit(db, {
    householdId: subjectHousehold.id,
    actor: delegate.id,
    surface: 'touch',
    action: 'grant.proposed',
    subject: g.id,
    capability: null,
    reason: `${delegate.displayName} asked to help with ${terms.categories
      .map((c) => humanCategory(c).toLowerCase())
      .join(', ')}. It does nothing until ${subjectHousehold.name} agrees.`,
    detail: { categories: terms.categories, spendCapCents: terms.spendCapCents },
  });
  return g;
}

/**
 * Accept. The caller must be an account inside the subject household: this is the one
 * place in Standby where the identity of the calling account is load-bearing, and it
 * is checked against the grant rather than inferred from anything spoken.
 */
export function acceptGrant(
  db: Db,
  caller: Account,
  code: string,
  via: 'voice' | 'touch',
): Grant {
  const g = grantByCode(db, code.replace(/\s+/g, ''));
  if (!g) {
    throw new StandbyError(
      'unknown_code',
      'On Behalf does not have an arrangement waiting on that code.',
    );
  }
  if (g.subjectHousehold !== caller.householdId) {
    throw new StandbyError(
      'wrong_household',
      'That code belongs to a different home, so On Behalf will not accept it here.',
    );
  }
  g.status = 'active';
  g.acceptedAt = nowIso();
  g.acceptedVia = via;
  g.subjectAccount = caller.id;
  g.pairingCode = null;
  saveGrant(db, g);

  const delegate = getAccount(db, g.delegateAccount)!;
  const house = getHousehold(db, g.subjectHousehold)!;
  queue(db, grantAccepted({ to: delegate, house, subject: caller, via }));
  writeAudit(db, {
    householdId: g.subjectHousehold,
    actor: caller.id,
    surface: via,
    action: 'grant.accepted',
    subject: g.id,
    capability: 'own_household',
    reason: `${caller.displayName} agreed to the arrangement ${via === 'voice' ? 'on their own Echo' : 'by tapping accept'}.`,
    detail: { via, delegate: delegate.displayName },
  });
  return g;
}

/** Pause, resume or end. Only the subject household may do any of the three. */
export function setGrantState(
  db: Db,
  caller: Account,
  grantId: string,
  next: 'active' | 'paused' | 'revoked',
): Grant {
  const grant = getGrant(db, grantId);
  if (!grant) {
    throw new StandbyError('unknown_grant', 'On Behalf has no arrangement with that number.');
  }
  if (grant.subjectHousehold !== caller.householdId) {
    throw new StandbyError(
      'not_yours_to_change',
      'Only the household being helped can pause or end an arrangement.',
    );
  }
  grant.status = next;
  if (next === 'revoked') {
    grant.revokedAt = nowIso();
    grant.revokedBy = caller.id;
  }
  saveGrant(db, grant);

  const delegate = getAccount(db, grant.delegateAccount)!;
  const house = getHousehold(db, grant.subjectHousehold)!;
  if (next !== 'active') {
    queue(db, grantEnded({ to: delegate, house, by: caller, state: next }));
  }
  writeAudit(db, {
    householdId: grant.subjectHousehold,
    actor: caller.id,
    surface: 'voice',
    action: `grant.${next}`,
    subject: grant.id,
    capability: 'own_household',
    reason:
      next === 'active'
        ? `${caller.displayName} resumed the arrangement.`
        : `${caller.displayName} ${next === 'paused' ? 'paused' : 'ended'} the arrangement. ${delegate.displayName} was told.`,
    detail: { next },
  });
  return grant;
}

export const activeGrant = (db: Db, delegate: string, household: string): Grant | null =>
  grantBetween(db, delegate, household);
