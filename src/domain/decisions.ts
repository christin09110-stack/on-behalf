// What happens to a held request once a person looks at it.
//
// Standby holds rather than guesses. A hold is visible at both ends, it expires
// rather than lingering, and only a person clears it. The model attached to a held
// request is an argument, never an action: `decideRequest` never reads the
// adjudication, and the tests check that approving something the model wanted
// declined still goes through.

import type { Db } from '../db.ts';
import type { Account, Household, Provider } from '../types.ts';
import {
  getAccount,
  getChange,
  getProvider,
  getVisit,
  grantBetween,
  saveChange,
  saveVisit,
  accountsIn,
  writeAudit,
  getHousehold,
} from './store.ts';
import { authorize } from './capability.ts';
import { queue } from './outbox.ts';
import * as msg from './messages.ts';
import { dayName, nowIso, readableTime } from '../clock.ts';
import { assertReadbackSafe, BOOKING_FACTS, money } from './readback.ts';
import { StandbyError } from './grants.ts';
import type { Actor, Outcome } from './visits.ts';

export function decideRequest(
  db: Db,
  actor: Actor,
  changeId: string,
  verdict: 'approve' | 'decline',
): Outcome {
  const change = getChange(db, changeId);
  if (!change) throw new StandbyError('unknown_change', 'On Behalf has no request with that number.');
  if (change.status !== 'held_for_delegate') {
    return { ok: false, code: 'already_settled', facts: { status: change.status } };
  }
  const visit = getVisit(db, change.visitId)!;
  const house = getHousehold(db, visit.householdId)!;
  const provider = getProvider(db, visit.providerId)!;

  const grant = grantBetween(db, actor.account.id, house.id);
  if (!grant || grant.status !== 'active') {
    throw new StandbyError(
      'no_grant',
      `There is no live arrangement letting ${actor.account.displayName} decide this.`,
    );
  }

  if (verdict === 'decline') {
    change.status = 'declined';
    change.decidedBy = actor.account.id;
    change.decidedAt = nowIso();
    saveChange(db, change);
    visit.status = 'cancelled';
    saveVisit(db, visit);
    tellHouse(db, house, provider, actor.account, 'declined');
    writeAudit(db, {
      householdId: house.id,
      actor: actor.account.id,
      surface: actor.surface,
      action: 'request.declined',
      subject: change.id,
      capability: 'within_scope',
      reason: `${actor.account.displayName} decided against arranging ${provider.name}. ${house.name} was told.`,
      detail: { visit: visit.id },
    });
    return { ok: true, code: 'declined', facts: { provider: provider.name, booked: false } };
  }

  // A request the household raised on their own speaker carries its own consent, so
  // the category allowlist does not apply to it: that list exists to stop the delegate
  // arranging things nobody asked for. The money limit still applies, because that one
  // protects the household rather than constraining it.
  const householdAsked = change.kind === 'new_visit';
  const decision = authorize({
    actor: actor.account,
    targetHousehold: house,
    action: 'book',
    category: householdAsked ? undefined : visit.category,
    priceCents: visit.priceCents,
    startsAt: householdAsked ? undefined : visit.startsAt,
    grant,
  });
  if (decision.verdict === 'deny') {
    return { ok: false, code: decision.code, facts: { refusal: decision.reason }, decision };
  }

  // The household asked for this themselves, so a hold that only exists to get their
  // agreement is already satisfied. A hold on money is not: that one still stands.
  const stillNeedsThem = decision.verdict === 'hold' && decision.code === 'over_spend_cap';
  visit.status = stillNeedsThem ? 'awaiting_subject' : 'booked';
  saveVisit(db, visit);
  change.status = 'applied';
  change.chosenSlot = visit.startsAt;
  change.decidedBy = actor.account.id;
  change.decidedAt = nowIso();
  saveChange(db, change);

  const subject = accountsIn(db, house.id)[0]!;
  if (stillNeedsThem) {
    queue(
      db,
      msg.needsHousehold({
        to: subject,
        house,
        provider,
        category: visit.category,
        whenIso: visit.startsAt,
        askedBy: actor.account,
        reason: decision.reason,
      }),
    );
  } else {
    for (const to of [subject, actor.account]) {
      queue(
        db,
        msg.bookingConfirmed({
          to,
          house,
          visit,
          provider,
          arrangedBy: actor.account,
          audience: to.householdId === house.id ? 'subject' : 'delegate',
        }),
      );
    }
  }

  writeAudit(db, {
    householdId: house.id,
    actor: actor.account.id,
    surface: actor.surface,
    action: stillNeedsThem ? 'request.approved_pending_household' : 'request.approved',
    subject: change.id,
    capability: decision.code,
    reason: stillNeedsThem
      ? `${actor.account.displayName} agreed, and it is above the limit ${house.name} set, so it waits for them.`
      : `${actor.account.displayName} agreed. ${provider.name} is booked for ${dayName(visit.startsAt, house.timezone)}.`,
    detail: { visit: visit.id, priceCents: visit.priceCents },
  });

  const facts = {
    provider: provider.name,
    service: visit.summary,
    day: dayName(visit.startsAt, house.timezone),
    time: readableTime(visit.startsAt, house.timezone),
    price: money(visit.priceCents),
    reference: visit.reference,
    confirmed: !stillNeedsThem,
  };
  assertReadbackSafe(facts, BOOKING_FACTS);
  return { ok: true, code: stillNeedsThem ? 'awaiting_household' : 'booked', facts };
}

function tellHouse(
  db: Db,
  house: Household,
  provider: Provider,
  by: Account,
  state: 'declined',
): void {
  const subject = accountsIn(db, house.id)[0];
  if (!subject) return;
  queue(db, {
    channel: 'sms',
    to: subject.sms ?? subject.email,
    kind: `request_${state}`,
    subject: `${provider.name} is not being arranged`,
    body:
      `On Behalf: ${by.displayName} has decided not to arrange ${provider.name} for now. ` +
      `Nothing is booked. Ask again on your Echo any time, or call ${by.displayName} about it.`,
  });
}

/** Everything waiting on this delegate, newest first. */
export function pendingFor(db: Db, delegate: Account) {
  const out = [];
  for (const g of db
    .prepare(`SELECT subjectHousehold FROM grant_row WHERE delegateAccount = ? AND status = 'active'`)
    .all(delegate.id as never) as Array<{ subjectHousehold: string }>) {
    const house = getHousehold(db, g.subjectHousehold)!;
    for (const c of db
      .prepare(
        `SELECT c.id FROM change_request c JOIN visit v ON v.id = c.visitId
         WHERE v.householdId = ? AND c.status = 'held_for_delegate' ORDER BY c.requestedAt DESC`,
      )
      .all(house.id as never) as Array<{ id: string }>) {
      const change = getChange(db, c.id)!;
      const visit = getVisit(db, change.visitId)!;
      out.push({
        change,
        visit,
        house,
        provider: getProvider(db, visit.providerId)!,
        askedBy: getAccount(db, change.requestedBy)!,
      });
    }
  }
  return out;
}
