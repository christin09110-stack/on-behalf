// The capability engine.
//
// Every Alexa+ service provider interface Amazon publishes carries one end-user
// identifier, one linked account and one appointment datastore. There is no documented
// notion of somebody acting for somebody else. This file is that notion.
//
// Three properties it has to hold, and the order matters:
//
//  - The relative is never locked out of their own house. A request from inside the
//    subject household is authorised on their own home ground, always. The delegate's
//    grant constrains the delegate, not the person they are standing by for.
//  - The delegate acts only inside terms the relative accepted, on the relative's own
//    device or by their own hand.
//  - Anything outside those terms is *held*, not silently dropped and not silently
//    performed. A held request is visible at both ends.
//
// Every decision carries a reason string written for a person, because the same string
// goes into the ledger, the console and the email.

import type { Category, Grant, Household, Account } from '../types.ts';
import { hourWord, hoursBetween, localHour, now } from '../clock.ts';

export type Action = 'book' | 'reschedule' | 'cancel' | 'read';

export type Verdict = 'allow' | 'hold' | 'deny';

export interface Decision {
  verdict: Verdict;
  /** Stable machine code. Goes in the ledger; the console groups on it. */
  code: string;
  /** One sentence, written for the household, not for a log reader. */
  reason: string;
  /** Present when the verdict is a hold: what would unblock it. */
  unblockedBy?: 'subject_consent' | 'delegate_decision';
}

export interface Request {
  actor: Account;
  targetHousehold: Household;
  action: Action;
  category?: Category;
  priceCents?: number;
  /** When the visit would start. Absent for reads. */
  startsAt?: string;
  grant: Grant | null;
}

const allow = (code: string, reason: string): Decision => ({ verdict: 'allow', code, reason });
const deny = (code: string, reason: string): Decision => ({ verdict: 'deny', code, reason });
const hold = (
  code: string,
  reason: string,
  unblockedBy: Decision['unblockedBy'],
): Decision => ({ verdict: 'hold', code, reason, unblockedBy });

export function authorize(req: Request): Decision {
  const ownHouse = req.actor.householdId === req.targetHousehold.id;

  if (ownHouse) {
    return allow(
      'own_household',
      `${req.actor.displayName} is asking about their own home, so On Behalf does not put anything in the way.`,
    );
  }

  const g = req.grant;
  if (!g) {
    return deny(
      'no_grant',
      `No one in ${req.targetHousehold.name} has agreed to let ${req.actor.displayName} act for them.`,
    );
  }
  if (g.delegateAccount !== req.actor.id || g.subjectHousehold !== req.targetHousehold.id) {
    return deny('grant_mismatch', 'That agreement does not cover this pair of households.');
  }
  if (g.status === 'proposed') {
    return deny(
      'grant_unaccepted',
      `${req.targetHousehold.name} has not accepted the arrangement yet. It takes effect when somebody there says the pairing code on their own speaker or taps accept.`,
    );
  }
  if (g.status === 'revoked') {
    return deny('grant_revoked', `The arrangement with ${req.targetHousehold.name} was ended.`);
  }
  // Pausing is the household saying "not now", not "never". The arrangement is still
  // theirs, it is still on both consoles, and resuming it is one tap — so a paused
  // delegate keeps looking and stops acting. `revoked`, `proposed` and `expired` are all
  // "there is no arrangement here", and those refuse the looking too.
  //
  // This distinction only became load-bearing when the MCP tools started going through
  // `authorize()` at all. Before that the read path never asked, so the ordering inside
  // this function was never the thing that decided what a paused delegate could see;
  // `liveGrantsForDelegate` was, and it says the same thing. Two places agreeing by
  // accident is not agreement, so the read carve-out is written here, where the refusal is.
  if (g.status === 'paused' && req.action !== 'read') {
    return deny(
      'grant_paused',
      `${req.targetHousehold.name} has paused the arrangement. Nothing can be booked or moved until it is resumed there.`,
    );
  }
  if (new Date(g.expiresAt) <= now()) {
    return deny(
      'grant_expired',
      `The arrangement with ${req.targetHousehold.name} ran out on ${g.expiresAt.slice(0, 10)} and needs accepting again.`,
    );
  }

  if (req.action === 'read') {
    return allow('within_scope', `Reading the diary is inside the arrangement.`);
  }
  if (req.action === 'book' && !g.mayBook) {
    return deny('action_not_granted', 'The arrangement does not cover making new bookings.');
  }
  if (req.action === 'reschedule' && !g.mayReschedule) {
    return deny('action_not_granted', 'The arrangement does not cover moving bookings.');
  }
  if (req.action === 'cancel' && !g.mayCancel) {
    return deny('action_not_granted', 'The arrangement does not cover cancelling bookings.');
  }
  if (req.category && !g.categories.includes(req.category)) {
    return deny(
      'category_not_in_scope',
      `${humanCategory(req.category)} is not one of the things ${req.targetHousehold.name} agreed to.`,
    );
  }
  if (req.priceCents !== undefined && req.priceCents > g.spendCapCents) {
    return hold(
      'over_spend_cap',
      `That is above the ${(g.spendCapCents / 100).toFixed(0)} dollar limit ${req.targetHousehold.name} agreed to, so somebody there has to agree to it before it goes ahead.`,
      'subject_consent',
    );
  }

  if (req.startsAt) {
    const notice = hoursBetween(now(), req.startsAt);
    if (notice < g.noticeHours) {
      return hold(
        'inside_notice_window',
        `That is less than ${g.noticeHours} hours away, and the arrangement says someone at ${req.targetHousehold.name} should agree before a visit that soon.`,
        'subject_consent',
      );
    }
    const hour = localHour(req.startsAt, req.targetHousehold.timezone);
    if (hour < g.earliestHour || hour >= g.latestHour) {
      return hold(
        'outside_agreed_hours',
        `The arrangement keeps visits between ${hourWord(g.earliestHour)} and ${hourWord(g.latestHour)} at ${req.targetHousehold.name}, so this time needs agreeing there first.`,
        'subject_consent',
      );
    }
  }

  return allow('within_scope', 'This is inside the arrangement as it was accepted.');
}

const CATEGORY_WORDS: Record<string, string> = {
  plumbing: 'Plumbing',
  heating: 'Heating',
  electrical: 'Electrical work',
  appliance_repair: 'Appliance repair',
  gardening: 'Gardening',
  cleaning: 'Cleaning',
  pest_control: 'Pest control',
  locksmith: 'Locksmith work',
  delivery: 'Deliveries',
  window_cleaning: 'Window cleaning',
  gutters: 'Gutter work',
  chimney: 'Chimney work',
};

export function humanCategory(c: string): string {
  return CATEGORY_WORDS[c] ?? c.replace(/_/g, ' ');
}
