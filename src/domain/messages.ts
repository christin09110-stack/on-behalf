// What the written channel actually says.
//
// These are the only place in Standby where sentences are written out in full, because
// this is the only channel Standby controls. The spoken channel gets facts and Alexa
// composes the sentence; email and SMS get prose, because here there is no model in
// between.
//
// House style: say the thing, say who did it, say what happens next, and never imply
// the reader has done something wrong.

import type { Account, Household, Provider, Visit } from '../types.ts';
import { readableDate, readableTime, readableWhen } from '../clock.ts';
import { money } from './readback.ts';
import { humanCategory } from './capability.ts';
import type { Draft } from './outbox.ts';

const sign = (h: Household) => `\nOn Behalf, on behalf of ${h.name}.`;

export function bookingConfirmed(args: {
  to: Account;
  house: Household;
  visit: Visit;
  provider: Provider;
  arrangedBy: Account;
  audience: 'subject' | 'delegate';
}): Draft {
  const { to, house, visit, provider, arrangedBy, audience } = args;
  const when = readableWhen(visit.startsAt, house.timezone);
  const who =
    audience === 'subject'
      ? `${arrangedBy.displayName} arranged this for you.`
      : `You arranged this for ${house.name}.`;
  return {
    channel: 'email',
    to: to.email,
    kind: 'booking_confirmed',
    relatedVisit: visit.id,
    subject: `${provider.name} is booked for ${readableDate(visit.startsAt, house.timezone)}`,
    body: [
      `${provider.name} is coming to ${house.name} on ${when}.`,
      '',
      `What for: ${visit.summary}`,
      `Cost: ${money(visit.priceCents)}`,
      `Reference: ${visit.reference}`,
      `Phone: ${provider.phone}`,
      '',
      who,
      '',
      `If it needs moving, anyone at ${house.name} can say so to their own Echo. You do not need this email to do it.`,
      '',
      `Cancelling: ${provider.cancellationPolicy}`,
      sign(house),
    ].join('\n'),
  };
}

export function visitMoved(args: {
  to: Account;
  house: Household;
  visit: Visit;
  provider: Provider;
  movedBy: Account;
  fromIso: string;
}): Draft {
  const { to, house, visit, provider, movedBy, fromIso } = args;
  return {
    channel: 'email',
    to: to.email,
    kind: 'visit_moved',
    relatedVisit: visit.id,
    subject: `${provider.name} moved to ${readableDate(visit.startsAt, house.timezone)}`,
    body: [
      `${provider.name} was coming to ${house.name} on ${readableWhen(fromIso, house.timezone)}.`,
      `It is now ${readableWhen(visit.startsAt, house.timezone)}.`,
      '',
      `${movedBy.displayName} asked for the change, on ${movedBy.householdId === house.id ? 'their own Echo' : 'the On Behalf console'}.`,
      `Reference: ${visit.reference}`,
      sign(house),
    ].join('\n'),
  };
}

export function visitCancelled(args: {
  to: Account;
  house: Household;
  visit: Visit;
  provider: Provider;
  cancelledBy: Account;
  feeCents: number;
}): Draft {
  const { to, house, visit, provider, cancelledBy, feeCents } = args;
  return {
    channel: 'email',
    to: to.email,
    kind: 'visit_cancelled',
    relatedVisit: visit.id,
    subject: `${provider.name} on ${readableDate(visit.startsAt, house.timezone)} is cancelled`,
    body: [
      `${provider.name} will not be coming to ${house.name} on ${readableWhen(visit.startsAt, house.timezone)}.`,
      '',
      feeCents > 0
        ? `There is a cancellation charge of ${money(feeCents)}. The policy was: ${provider.cancellationPolicy}`
        : `There is no cancellation charge. The policy was: ${provider.cancellationPolicy}`,
      '',
      `${cancelledBy.displayName} cancelled it.`,
      `Reference: ${visit.reference}`,
      sign(house),
    ].join('\n'),
  };
}

export function changeHeld(args: {
  to: Account;
  house: Household;
  visit: Visit;
  provider: Provider;
  reason: string;
  consoleUrl: string;
}): Draft {
  const { to, house, visit, provider, reason, consoleUrl } = args;
  return {
    channel: 'email',
    to: to.email,
    kind: 'change_held',
    relatedVisit: visit.id,
    subject: `Waiting on you: ${provider.name} at ${house.name}`,
    body: [
      `Something about ${provider.name} at ${house.name} is waiting for a decision.`,
      '',
      `What was asked for concerns ${readableWhen(visit.startsAt, house.timezone)}.`,
      `Why it is waiting: ${reason}`,
      '',
      `Nothing has changed at ${house.name} and nothing will until you decide.`,
      `Decide here: ${consoleUrl}`,
      sign(house),
    ].join('\n'),
  };
}

export function needsHousehold(args: {
  to: Account;
  house: Household;
  provider: Provider;
  category: string;
  whenIso: string;
  askedBy: Account;
  reason: string;
}): Draft {
  const { to, house, provider, category, whenIso, askedBy, reason } = args;
  return {
    channel: 'sms',
    to: to.sms ?? to.email,
    kind: 'needs_household',
    subject: `${provider.name} wants ${readableTime(whenIso, house.timezone)}`,
    body:
      `On Behalf: ${askedBy.displayName} would like ${provider.name} to come for ` +
      `${humanCategory(category).toLowerCase()} on ${readableWhen(whenIso, house.timezone)}. ` +
      `${reason} Say "Alexa, ask On Behalf what is waiting" to hear it, or tap accept in the app.`,
  };
}

export function grantProposed(args: {
  to: Account;
  house: Household;
  delegate: Account;
  code: string;
  categories: string[];
  capCents: number;
}): Draft {
  const { to, house, delegate, code, categories, capCents } = args;
  return {
    channel: 'sms',
    to: to.sms ?? to.email,
    kind: 'grant_proposed',
    subject: 'On Behalf pairing code',
    body:
      `On Behalf: ${delegate.displayName} would like to help with ` +
      `${categories.map((c) => humanCategory(c).toLowerCase()).join(', ')} at ${house.name}, ` +
      `up to ${money(capCents)} a time. Nothing happens until you agree. ` +
      `Say "Alexa, tell On Behalf ${code}" on your own Echo, or tap accept.`,
  };
}

export function grantAccepted(args: {
  to: Account;
  house: Household;
  subject: Account;
  via: 'voice' | 'touch';
}): Draft {
  const { to, house, subject, via } = args;
  return {
    channel: 'email',
    to: to.email,
    kind: 'grant_accepted',
    subject: `${subject.displayName} agreed`,
    body: [
      `${subject.displayName} accepted the On Behalf arrangement for ${house.name}, ` +
        `${via === 'voice' ? 'by saying the code to their own Echo' : 'by tapping accept'}.`,
      '',
      `They can pause or end it from their own Echo at any time, without going through you.`,
      sign(house),
    ].join('\n'),
  };
}

export function grantEnded(args: {
  to: Account;
  house: Household;
  by: Account;
  state: 'paused' | 'revoked';
}): Draft {
  const { to, house, by, state } = args;
  return {
    channel: 'email',
    to: to.email,
    kind: `grant_${state}`,
    subject: `${house.name} ${state === 'paused' ? 'paused' : 'ended'} the arrangement`,
    body: [
      `${by.displayName} ${state === 'paused' ? 'paused' : 'ended'} the On Behalf arrangement for ${house.name}.`,
      '',
      state === 'paused'
        ? `Nothing can be booked or moved there until somebody at ${house.name} resumes it. Visits already in the diary stand.`
        : `Visits already in the diary stand. Nothing further can be arranged.`,
      sign(house),
    ].join('\n'),
  };
}

export function weeklyBrief(args: {
  to: Account;
  house: Household;
  body: string;
  fromFallback: boolean;
}): Draft {
  const { to, house, body, fromFallback } = args;
  return {
    channel: 'email',
    to: to.email,
    kind: 'weekly_brief',
    subject: `${house.name}: where things stand`,
    body: [
      body,
      '',
      fromFallback
        ? '(Written from the ledger. The summarising model was unreachable, so this is the plain list rather than a read of it.)'
        : '',
      sign(house),
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
