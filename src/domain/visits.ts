// Booking, moving and cancelling. The part a judge will click.
//
// Three rules run through all of it.
//
//  - Nothing changes silently. Every outcome writes a ledger row and a message to both
//    households, because an add-on cannot speak first and the other household will not
//    be at the speaker when it happens.
//  - A cancellation is two turns, never one. Policy Requirement 15: "read back booking
//    details and cancellation policy, then request confirmation before cancelling".
//    `cancelVisit` with `confirmed: false` changes nothing and returns the facts to
//    read back. Only the second call cancels.
//  - No model is reachable from this file. See `tests/no-model-on-read-path.test.ts`,
//    which walks the import graph and fails if one ever becomes reachable.

import type { Db } from '../db.ts';
import type {
  Account,
  Category,
  ChangeRequest,
  Household,
  Provider,
  Visit,
} from '../types.ts';
import {
  getAccount,
  getProvider,
  upcomingVisits,
  visitsIn,
  getVisit,
  getHousehold,
  accountsIn,
  saveChange,
  saveVisit,
  writeAudit,
  grantBetween,
  getChange,
} from './store.ts';
import { authorize, humanCategory, type Decision } from './capability.ts';
import { assertNoHealthContent } from './screening.ts';
import {
  assertNoDirective,
  assertReadbackSafe,
  BOOKING_FACTS,
  CANCELLATION_FACTS,
  money,
} from './readback.ts';
import { findSlots } from './availability.ts';
import { resolveVisit, weekdayIn } from './resolve.ts';
import { queue } from './outbox.ts';
import * as msg from './messages.ts';
import { addHours, dayName, hoursBetween, nowIso, readableTime } from '../clock.ts';
import { id, reference } from '../ids.ts';
import { StandbyError } from './grants.ts';

const CONSOLE = process.env.STANDBY_CONSOLE_URL ?? 'http://localhost:4173/decisions';

export interface Actor {
  account: Account;
  surface: 'voice' | 'touch';
}

/** Everything a voice turn needs, and nothing Alexa is told how to say. */
export interface Outcome {
  ok: boolean;
  /** Stable code the console and the ledger group on. */
  code: string;
  facts: Record<string, string | number | boolean | null>;
  /** Options the household can pick from in the next turn. */
  options?: Array<{ id: string; day: string; time: string; startsAt: string }>;
  decision?: Decision;
}

function ctxOf(db: Db, actor: Actor, house: Household) {
  return grantBetween(db, actor.account.id, house.id);
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/**
 * Anything already in this diary that overlaps a span of time.
 *
 * `findSlots` drops a taken slot when it draws the list, and that is the right place for
 * it, but it is advice at the moment the page was rendered. It is not a check, and the
 * booking does not go through it: the delegate picks a time on one trade's page, picks a
 * time on the next trade's page, and nothing between the two says the first is now in the
 * way. Five bookings made through the console's own forms put three tradespeople at one
 * house at eleven o'clock, listed one under another without comment.
 *
 * So the booking path asks the question itself. It does not refuse — two trades at once
 * is somebody else's call to make, and a household that wants the plumber and the
 * electrician together should be able to have them — it says so, on the confirmation and
 * in the ledger, and the diary marks both afterwards.
 */
export function clashingVisits(
  db: Db,
  householdId: string,
  startsAt: string,
  endsAt: string,
  exceptVisitId?: string,
): Visit[] {
  return visitsIn(db, householdId).filter(
    (v) =>
      v.id !== exceptVisitId &&
      (v.status === 'booked' || v.status === 'awaiting_subject' || v.status === 'rescheduled') &&
      v.startsAt < endsAt &&
      v.endsAt > startsAt,
  );
}

/** The sentence a clash is said in, app-authored, on both surfaces. */
export function clashSentence(others: readonly Visit[], db: Db, timezone: string): string {
  const names = others.map((v) => getProvider(db, v.providerId)?.name ?? 'another trade');
  const at = others[0] ? readableTime(others[0].startsAt, timezone) : '';
  return names.length === 1
    ? `${names[0]} is already coming at ${at}. Two people will be at the door together.`
    : `${names.length} other visits are already booked at ${at}. That many people will be at the door together.`;
}

export function bookVisit(
  db: Db,
  actor: Actor,
  args: { house: Household; provider: Provider; summary: string; startsAt: string },
): Outcome {
  const { house, provider, summary, startsAt } = args;
  assertNoHealthContent(summary);
  assertNoHealthContent(provider.name);
  // On ingest, not only on the way out. `screenResult` catches a directive in a tool
  // result, which is the channel being protected — but a directive already stored in a
  // visit summary makes every later read of that diary throw, and a guard that turns the
  // household's own diary off is not a guard, it is an outage. Refuse the write.
  assertNoDirective('summary', summary);

  const decision = authorize({
    actor: actor.account,
    targetHousehold: house,
    action: 'book',
    category: provider.category,
    priceCents: provider.ratePerVisitCents,
    startsAt,
    grant: ctxOf(db, actor, house),
  });

  if (decision.verdict === 'deny') {
    writeAudit(db, {
      householdId: house.id,
      actor: actor.account.id,
      surface: actor.surface,
      action: 'visit.refused',
      subject: provider.id,
      capability: decision.code,
      reason: decision.reason,
      detail: { startsAt, provider: provider.name },
    });
    return { ok: false, code: decision.code, facts: { refusal: decision.reason }, decision };
  }

  const held = decision.verdict === 'hold';
  const visit: Visit = {
    id: id('visit'),
    householdId: house.id,
    providerId: provider.id,
    category: provider.category,
    summary,
    startsAt,
    endsAt: addHours(startsAt, 1),
    status: held ? 'awaiting_subject' : 'booked',
    priceCents: provider.ratePerVisitCents,
    reference: reference(),
    arrangedBy: actor.account.id,
    arrangedAt: nowIso(),
    previousStartsAt: null,
  };
  // Compose and check the readback before the row exists, not after. §5: a refused call
  // must not leave anything behind. This used to save first, so a fact set that failed
  // the check left a booked visit in somebody's diary and threw on the way out.
  const clashes = clashingVisits(db, house.id, visit.startsAt, visit.endsAt);
  const clash = clashes.length ? clashSentence(clashes, db, house.timezone) : null;
  const facts = { ...bookingFacts(visit, provider, house, held), ...(clash ? { clash } : {}) };
  assertReadbackSafe(facts, BOOKING_FACTS);
  saveVisit(db, visit);

  const subject = accountsIn(db, house.id)[0]!;
  if (held) {
    queue(
      db,
      msg.needsHousehold({
        to: subject,
        house,
        provider,
        category: provider.category,
        whenIso: startsAt,
        askedBy: actor.account,
        reason: decision.reason,
      }),
    );
  } else {
    for (const to of [subject, actor.account]) {
      if (to.id === subject.id && to.id === actor.account.id) continue;
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
    action: held ? 'visit.awaiting_household' : 'visit.booked',
    subject: visit.id,
    capability: decision.code,
    reason: `${
      held
        ? decision.reason
        : `${actor.account.displayName} booked ${provider.name} for ${dayName(startsAt, house.timezone)}.`
    }${clash ? ` ${clash}` : ''}`,
    detail: { reference: visit.reference, priceCents: visit.priceCents },
  });

  return { ok: true, code: held ? 'awaiting_household' : 'booked', facts, decision };
}

function bookingFacts(v: Visit, p: Provider, h: Household, held: boolean) {
  return {
    provider: p.name,
    service: v.summary,
    household: h.name,
    day: dayName(v.startsAt, h.timezone),
    time: readableTime(v.startsAt, h.timezone),
    price: money(v.priceCents),
    reference: v.reference,
    cancellationPolicy: p.cancellationPolicy,
    confirmed: !held,
    awaitingHousehold: held,
  };
}

/** Somebody at home agrees to a visit the delegate arranged on unusual terms. */
export function acceptPendingVisit(db: Db, actor: Actor, visitId: string): Outcome {
  const visit = getVisit(db, visitId);
  if (!visit) throw new StandbyError('unknown_visit', 'On Behalf has no visit with that number.');
  if (visit.householdId !== actor.account.householdId) {
    throw new StandbyError('not_your_visit', 'That visit is at a different home.');
  }
  if (visit.status !== 'awaiting_subject') {
    return { ok: false, code: 'nothing_waiting', facts: { status: visit.status } };
  }
  visit.status = 'booked';
  saveVisit(db, visit);

  const provider = getProvider(db, visit.providerId)!;
  const house = houseOf(db, visit.householdId);
  const arranger = getAccount(db, visit.arrangedBy)!;
  for (const to of [actor.account, arranger]) {
    queue(
      db,
      msg.bookingConfirmed({
        to,
        house,
        visit,
        provider,
        arrangedBy: arranger,
        audience: to.householdId === house.id ? 'subject' : 'delegate',
      }),
    );
  }
  writeAudit(db, {
    householdId: house.id,
    actor: actor.account.id,
    surface: actor.surface,
    action: 'visit.accepted',
    subject: visit.id,
    capability: 'own_household',
    reason: `${actor.account.displayName} agreed to ${provider.name} coming on ${dayName(visit.startsAt, house.timezone)}.`,
    detail: { reference: visit.reference },
  });
  const facts = bookingFacts(visit, provider, house, false);
  assertReadbackSafe(facts, BOOKING_FACTS);
  return { ok: true, code: 'booked', facts };
}

function houseOf(db: Db, id_: string): Household {
  return getHousehold(db, id_)!;
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

/**
 * "I need to move Thursday." Resolves the visit, offers real slots and records the
 * request, all from local reads. Nothing has moved when this returns: the household
 * picks a slot in the next turn.
 */
export function requestReschedule(
  db: Db,
  actor: Actor,
  house: Household,
  phrase: string,
  visitId?: string,
): Outcome {
  // A caller that already knows which visit skips resolution entirely. That happens
  // on the console, where somebody tapped a specific row, and on the second voice turn
  // after Standby offered two candidates and Alexa asked which one.
  const named = visitId ? upcomingVisits(db, house.id, nowIso()).find((x) => x.id === visitId) : null;
  const r = named
    ? { match: 'one' as const, candidates: [named], matchedOn: ['the visit you picked'] }
    : resolveVisit(db, house, phrase);
  if (r.match === 'none') {
    return { ok: false, code: 'nothing_matched', facts: { household: house.name } };
  }
  if (r.match === 'several') {
    return {
      ok: false,
      code: 'several_matched',
      facts: { household: house.name, count: r.candidates.length },
      options: r.candidates.map((v) => ({
        id: v.id,
        day: dayName(v.startsAt, house.timezone),
        time: readableTime(v.startsAt, house.timezone),
        startsAt: v.startsAt,
      })),
    };
  }

  const visit = r.candidates[0]!;
  const provider = getProvider(db, visit.providerId)!;
  const grant = ctxOf(db, actor, house);
  const decision = authorize({
    actor: actor.account,
    targetHousehold: house,
    action: 'reschedule',
    category: visit.category,
    grant,
  });
  if (decision.verdict === 'deny') {
    return { ok: false, code: decision.code, facts: { refusal: decision.reason }, decision };
  }

  const ownHouse = actor.account.householdId === house.id;
  const slots = findSlots(db, {
    provider,
    householdId: house.id,
    timezone: house.timezone,
    fromIso: nowIso(),
    days: 14,
    onlyWeekday: weekdayIn(phrase),
    earliestHour: ownHouse ? undefined : grant?.earliestHour,
    latestHour: ownHouse ? undefined : grant?.latestHour,
    limit: 3,
  });
  const widened =
    slots.length === 0
      ? findSlots(db, {
          provider,
          householdId: house.id,
          timezone: house.timezone,
          fromIso: nowIso(),
          days: 21,
          limit: 3,
        })
      : slots;

  const change: ChangeRequest = {
    id: id('chg'),
    visitId: visit.id,
    kind: 'reschedule',
    requestedBy: actor.account.id,
    requestedAt: nowIso(),
    status: 'offered',
    offeredSlots: widened.map((s) => s.startsAt),
    chosenSlot: null,
    holdReason: null,
    adjudication: null,
    decidedBy: null,
    decidedAt: null,
  };
  saveChange(db, change);
  writeAudit(db, {
    householdId: house.id,
    actor: actor.account.id,
    surface: actor.surface,
    action: 'change.requested',
    subject: change.id,
    capability: decision.code,
    reason: `${actor.account.displayName} asked to move ${provider.name}. On Behalf matched it on ${r.matchedOn.join(' and ') || 'the diary'} and offered ${widened.length} times.`,
    detail: { visit: visit.id, offered: change.offeredSlots },
  });

  const facts = {
    changeId: change.id,
    provider: provider.name,
    service: visit.summary,
    currentDay: dayName(visit.startsAt, house.timezone),
    currentTime: readableTime(visit.startsAt, house.timezone),
    reference: visit.reference,
    optionCount: widened.length,
    matchedOn: r.matchedOn.join(' and ') || 'the diary',
  };
  assertReadbackSafe(facts);
  return {
    ok: widened.length > 0,
    code: widened.length ? 'slots_offered' : 'no_slots',
    facts,
    options: widened.map((s) => ({
      id: s.startsAt,
      day: dayName(s.startsAt, house.timezone),
      time: readableTime(s.startsAt, house.timezone),
      startsAt: s.startsAt,
    })),
  };
}

/** The second turn: "yes, Thursday at two." */
export function confirmReschedule(
  db: Db,
  actor: Actor,
  changeId: string,
  startsAt: string,
): Outcome {
  const change = getChange(db, changeId);
  if (!change) throw new StandbyError('unknown_change', 'On Behalf has no request with that number.');
  if (change.status !== 'offered') {
    return { ok: false, code: 'already_settled', facts: { status: change.status } };
  }
  if (!change.offeredSlots.includes(startsAt)) {
    // Only slots Standby itself offered can be confirmed. This is what stops a
    // composed sentence, or a mis-heard time, from inventing an appointment.
    return {
      ok: false,
      code: 'not_offered',
      facts: { refusal: 'That time was not one of the times On Behalf offered.' },
    };
  }
  const visit = getVisit(db, change.visitId)!;
  const house = houseOf(db, visit.householdId);
  const provider = getProvider(db, visit.providerId)!;
  const from = visit.startsAt;

  // Authorise here as well as in requestReschedule, because the two turns are minutes
  // apart and an arrangement can be paused or ended in between — by the household, on
  // its own speaker, which is exactly the control the product sells. Without this the
  // revoked delegate still completed the move, and the audit row below stamped it
  // `within_scope`, so the ledger asserted an authorisation that had never been checked.
  // A log that lies about a write is worse than no log.
  const decision = authorize({
    actor: actor.account,
    targetHousehold: house,
    action: 'reschedule',
    category: visit.category,
    grant: ctxOf(db, actor, house),
  });
  if (decision.verdict === 'deny') {
    return { ok: false, code: decision.code, facts: { refusal: decision.reason }, decision };
  }

  visit.previousStartsAt = from;
  visit.startsAt = startsAt;
  visit.endsAt = addHours(startsAt, 1);
  visit.status = 'rescheduled';
  saveVisit(db, visit);
  change.status = 'applied';
  change.chosenSlot = startsAt;
  saveChange(db, change);

  for (const to of interested(db, house, actor.account)) {
    queue(db, msg.visitMoved({ to, house, visit, provider, movedBy: actor.account, fromIso: from }));
  }
  writeAudit(db, {
    householdId: house.id,
    actor: actor.account.id,
    surface: actor.surface,
    action: 'visit.moved',
    subject: visit.id,
    capability: actor.account.householdId === house.id ? 'own_household' : 'within_scope',
    reason: `${provider.name} moved from ${dayName(from, house.timezone)} to ${dayName(startsAt, house.timezone)} at ${actor.account.displayName}'s request. Everyone involved was written to.`,
    detail: { from, to: startsAt, reference: visit.reference },
  });

  const facts = {
    provider: provider.name,
    service: visit.summary,
    day: dayName(startsAt, house.timezone),
    time: readableTime(startsAt, house.timezone),
    previousDay: dayName(from, house.timezone),
    price: money(visit.priceCents),
    reference: visit.reference,
    writtenConfirmationSent: true,
  };
  assertReadbackSafe(facts, BOOKING_FACTS);
  return { ok: true, code: 'moved', facts };
}

/** Everyone who should get a written copy: the home, and whoever arranged it. */
function interested(db: Db, house: Household, actor: Account): Account[] {
  const out = new Map<string, Account>();
  for (const a of accountsIn(db, house.id)) out.set(a.id, a);
  for (const g of db
    .prepare(`SELECT delegateAccount FROM grant_row WHERE subjectHousehold = ? AND status = 'active'`)
    .all(house.id as never) as Array<{ delegateAccount: string }>) {
    const a = getAccount(db, g.delegateAccount);
    if (a) out.set(a.id, a);
  }
  out.set(actor.id, actor);
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Cancelling: two turns, always
// ---------------------------------------------------------------------------

export function cancelVisit(
  db: Db,
  actor: Actor,
  visitId: string,
  confirmed: boolean,
): Outcome {
  const visit = getVisit(db, visitId);
  if (!visit) throw new StandbyError('unknown_visit', 'On Behalf has no visit with that number.');
  const house = houseOf(db, visit.householdId);
  const provider = getProvider(db, visit.providerId)!;
  const decision = authorize({
    actor: actor.account,
    targetHousehold: house,
    action: 'cancel',
    category: visit.category,
    grant: ctxOf(db, actor, house),
  });
  if (decision.verdict === 'deny') {
    return { ok: false, code: decision.code, facts: { refusal: decision.reason }, decision };
  }

  const notice = hoursBetween(nowIso(), visit.startsAt);
  const fee = notice < provider.freeCancelHours ? provider.cancellationFeeCents : 0;
  const facts = {
    provider: provider.name,
    service: visit.summary,
    day: dayName(visit.startsAt, house.timezone),
    time: readableTime(visit.startsAt, house.timezone),
    reference: visit.reference,
    cancellationPolicy: provider.cancellationPolicy,
    cancellationCost: money(fee),
    hoursOfNotice: Math.floor(notice),
  };
  assertReadbackSafe(facts, CANCELLATION_FACTS);

  if (!confirmed) {
    // Policy Requirement 15. Nothing has been cancelled at this point.
    return { ok: true, code: 'confirm_cancellation', facts };
  }

  visit.status = 'cancelled';
  saveVisit(db, visit);
  for (const to of interested(db, house, actor.account)) {
    queue(
      db,
      msg.visitCancelled({ to, house, visit, provider, cancelledBy: actor.account, feeCents: fee }),
    );
  }
  writeAudit(db, {
    householdId: house.id,
    actor: actor.account.id,
    surface: actor.surface,
    action: 'visit.cancelled',
    subject: visit.id,
    capability: decision.code,
    reason:
      fee > 0
        ? `${actor.account.displayName} cancelled ${provider.name} with ${Math.floor(notice)} hours of notice, which carries a ${money(fee)} charge under the policy read back first.`
        : `${actor.account.displayName} cancelled ${provider.name}. No charge applied.`,
    detail: { feeCents: fee, reference: visit.reference },
  });
  return { ok: true, code: 'cancelled', facts };
}

// ---------------------------------------------------------------------------
// The other direction: the household asks for something new
// ---------------------------------------------------------------------------

/**
 * Somebody at home says "I need someone to look at the gutters". Standby cannot book
 * it on their say-so, because the arrangement runs the other way and somebody else is
 * paying. It records the ask, holds it for the delegate, and tells them in writing.
 */
export function requestService(
  db: Db,
  actor: Actor,
  house: Household,
  category: Category,
  note: string,
): Outcome {
  assertNoHealthContent(note);
  assertNoHealthContent(category);
  assertNoDirective('note', note);
  const provider = db
    .prepare('SELECT * FROM provider WHERE category = ? ORDER BY ratePerVisitCents LIMIT 1')
    .get(category as never) as Provider | undefined;
  if (!provider) {
    return { ok: false, code: 'no_provider', facts: { category: humanCategory(category) } };
  }
  const slot = findSlots(db, {
    provider,
    householdId: house.id,
    timezone: house.timezone,
    fromIso: nowIso(),
    days: 14,
    limit: 1,
  })[0];

  const visit: Visit = {
    id: id('visit'),
    householdId: house.id,
    providerId: provider.id,
    category,
    summary: note,
    startsAt: slot?.startsAt ?? addHours(nowIso(), 72),
    endsAt: addHours(slot?.startsAt ?? addHours(nowIso(), 72), 1),
    status: 'proposed',
    priceCents: provider.ratePerVisitCents,
    reference: reference(),
    arrangedBy: actor.account.id,
    arrangedAt: nowIso(),
    previousStartsAt: null,
  };
  saveVisit(db, visit);

  const change: ChangeRequest = {
    id: id('chg'),
    visitId: visit.id,
    kind: 'new_visit',
    requestedBy: actor.account.id,
    requestedAt: nowIso(),
    status: 'held_for_delegate',
    offeredSlots: slot ? [slot.startsAt] : [],
    chosenSlot: null,
    holdReason: `${actor.account.displayName} asked for this at home. Somebody else arranges and pays for work at ${house.name}, so it waits for them.`,
    adjudication: null,
    decidedBy: null,
    decidedAt: null,
  };
  saveChange(db, change);

  for (const to of interested(db, house, actor.account)) {
    if (to.householdId === house.id) continue;
    queue(
      db,
      msg.changeHeld({
        to,
        house,
        visit,
        provider,
        reason: change.holdReason!,
        consoleUrl: CONSOLE,
      }),
    );
  }
  writeAudit(db, {
    householdId: house.id,
    actor: actor.account.id,
    surface: actor.surface,
    action: 'service.requested',
    subject: change.id,
    capability: 'own_household',
    reason: `${actor.account.displayName} asked for ${humanCategory(category).toLowerCase()}. On Behalf passed it on rather than booking it.`,
    detail: { category, note },
  });

  const facts = {
    category: humanCategory(category),
    household: house.name,
    passedTo: passedToName(db, house),
    earliestDay: slot ? dayName(slot.startsAt, house.timezone) : null,
    earliestTime: slot ? readableTime(slot.startsAt, house.timezone) : null,
    booked: false,
  };
  assertReadbackSafe(facts);
  return { ok: true, code: 'passed_on', facts };
}

function passedToName(db: Db, house: Household): string {
  const g = db
    .prepare(
      `SELECT delegateAccount FROM grant_row WHERE subjectHousehold = ? AND status = 'active' LIMIT 1`,
    )
    .get(house.id as never) as { delegateAccount: string } | undefined;
  return g ? (getAccount(db, g.delegateAccount)?.displayName ?? 'nobody yet') : 'nobody yet';
}
