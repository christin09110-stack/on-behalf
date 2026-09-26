// The tools the older relative's own Echo calls.
//
// Every one of them answers rather than announces, because an Alexa+ add-on cannot
// speak first. That shaped the whole set: there is no tool here that would only be
// useful if it could interrupt you. "What is waiting" exists precisely because nothing
// can come and find you.

import { z } from 'zod';
import type { ToolDef } from './registry.ts';
import { householdArg } from './registry.ts';
import {
  householdOfChange,
  householdOfVisit,
  ownHousehold,
  readsHousehold,
  targetHousehold,
} from './authorize.ts';
import {
  auditFor,
  getAccount,
  getProvider,
  grantsOverHousehold,
  upcomingVisits,
  visitsIn,
} from '../domain/store.ts';
import {
  acceptPendingVisit,
  cancelVisit,
  confirmReschedule,
  requestReschedule,
  requestService,
} from '../domain/visits.ts';
import { acceptGrant, setGrantState } from '../domain/grants.ts';
import { dayName, nowIso, readableTime } from '../clock.ts';
import { money } from '../domain/readback.ts';
import { humanCategory } from '../domain/capability.ts';
import { CATEGORIES } from '../types.ts';

const actorOf = (caller: { account: import('../types.ts').Account; surface: string }) => ({
  account: caller.account,
  surface: (caller.surface === 'touch' ? 'touch' : 'voice') as 'voice' | 'touch',
});

export const householdTools: ToolDef[] = [
  {
    name: 'get_visits',
    title: 'What is coming',
    description:
      'Visits booked at a home: who is coming, what for, which day and at what time. Use for questions like "when is the plumber coming" or "what is happening this week".',
    audience: 'both',
    touchRoute: '/home',
    writes: false,
    subject: readsHousehold(),
    input: { ...householdArg },
    run(db, caller, args) {
      const house = targetHousehold(db, caller, args.household);
      const visits = upcomingVisits(db, house.id, nowIso());
      return {
        ok: true,
        code: visits.length ? 'visits' : 'nothing_booked',
        facts: { household: house.name, count: visits.length },
        rows: visits.map((v) => {
          const p = getProvider(db, v.providerId);
          return {
            visitId: v.id,
            provider: p?.name ?? 'a provider',
            service: v.summary,
            day: dayName(v.startsAt, house.timezone),
            time: readableTime(v.startsAt, house.timezone),
            price: money(v.priceCents),
            reference: v.reference,
            confirmed: v.status !== 'awaiting_subject',
          };
        }),
      };
    },
  },
  {
    name: 'who_arranged',
    title: 'Who arranged this',
    description:
      'Who booked a visit and when. Use when someone asks "who arranged that" or "did my son book this".',
    audience: 'household',
    touchRoute: '/home',
    writes: false,
    subject: readsHousehold(),
    input: { ...householdArg, visitId: z.string().describe('The visit in question.') },
    run(db, caller, args) {
      const house = targetHousehold(db, caller, args.household);
      const visit = visitsIn(db, house.id).find((v) => v.id === args.visitId);
      if (!visit) return { ok: false, code: 'unknown_visit', facts: { household: house.name } };
      const by = getAccount(db, visit.arrangedBy);
      const p = getProvider(db, visit.providerId);
      return {
        ok: true,
        code: 'arranged_by',
        facts: {
          provider: p?.name ?? 'a provider',
          arrangedBy: by?.displayName ?? 'someone no longer linked',
          arrangedOn: visit.arrangedAt.slice(0, 10),
          day: dayName(visit.startsAt, house.timezone),
          time: readableTime(visit.startsAt, house.timezone),
          reference: visit.reference,
        },
      };
    },
  },
  {
    name: 'request_change',
    title: 'Ask to move a visit',
    description:
      'Start moving a booked visit. Takes the words the person used, such as "Thursday" or "the plumber". Returns the times that are actually free. Nothing moves until confirm_change.',
    audience: 'both',
    touchRoute: '/home',
    writes: true,
    subject: readsHousehold('reschedule'),
    input: {
      ...householdArg,
      phrase: z.string().describe('What the person said, such as "move Thursday".'),
      visitId: z
        .string()
        .optional()
        .describe('Set this instead of guessing when the visit is already known.'),
    },
    run(db, caller, args) {
      const house = targetHousehold(db, caller, args.household);
      return requestReschedule(
        db,
        actorOf(caller),
        house,
        String(args.phrase ?? ''),
        args.visitId ? String(args.visitId) : undefined,
      );
    },
  },
  {
    name: 'confirm_change',
    title: 'Confirm a new time',
    description:
      'Move a visit to one of the times request_change offered. Refuses any other time.',
    audience: 'both',
    touchRoute: '/home',
    writes: true,
    // The two turns are minutes apart and the arrangement can end in between, so the
    // second turn is authorised on the household the change belongs to, not on a hint.
    subject: (db, _caller, args) => ({
      household: householdOfChange(db, args.changeId),
      action: 'reschedule',
    }),
    input: {
      changeId: z.string().describe('The request returned by request_change.'),
      startsAt: z.string().describe('One of the offered times, as returned.'),
    },
    run(db, caller, args) {
      return confirmReschedule(
        db,
        actorOf(caller),
        String(args.changeId),
        String(args.startsAt),
      );
    },
  },
  {
    name: 'start_cancellation',
    title: 'Read back before cancelling',
    description:
      'Reads out the booking and the cancellation policy, including any charge. Cancels nothing. Always call this before confirm_cancellation.',
    audience: 'both',
    touchRoute: '/home',
    writes: false,
    // Reading the policy back cancels nothing, so this is a read. `confirm_cancellation`
    // below is the one that needs the arrangement to grant cancelling.
    subject: (db, _caller, args) => ({
      household: householdOfVisit(db, args.visitId),
      action: 'read',
    }),
    input: { visitId: z.string() },
    run(db, caller, args) {
      return cancelVisit(db, actorOf(caller), String(args.visitId), false);
    },
  },
  {
    name: 'confirm_cancellation',
    title: 'Cancel',
    description:
      'Cancel a visit after the policy has been read back and the person has agreed.',
    audience: 'both',
    touchRoute: '/home',
    writes: true,
    subject: (db, _caller, args) => ({
      household: householdOfVisit(db, args.visitId),
      action: 'cancel',
    }),
    input: { visitId: z.string() },
    run(db, caller, args) {
      return cancelVisit(db, actorOf(caller), String(args.visitId), true);
    },
  },
  {
    name: 'what_is_waiting',
    title: 'What needs me',
    description:
      'Anything at this home that is waiting on the person at home: a visit arranged on unusual terms, or an arrangement not yet accepted.',
    audience: 'household',
    touchRoute: '/waiting',
    writes: false,
    subject: readsHousehold(),
    input: { ...householdArg },
    run(db, caller, args) {
      const house = targetHousehold(db, caller, args.household);
      const waiting = visitsIn(db, house.id).filter((v) => v.status === 'awaiting_subject');
      const proposed = grantsOverHousehold(db, house.id).filter((g) => g.status === 'proposed');
      return {
        ok: true,
        code: waiting.length || proposed.length ? 'waiting' : 'nothing_waiting',
        facts: {
          household: house.name,
          visitsWaiting: waiting.length,
          arrangementsWaiting: proposed.length,
        },
        rows: [
          ...waiting.map((v) => {
            const p = getProvider(db, v.providerId);
            return {
              kind: 'visit',
              visitId: v.id,
              provider: p?.name ?? 'a provider',
              service: v.summary,
              day: dayName(v.startsAt, house.timezone),
              time: readableTime(v.startsAt, house.timezone),
              price: money(v.priceCents),
              askedBy: getAccount(db, v.arrangedBy)?.displayName ?? 'someone',
            };
          }),
          ...proposed.map((g) => ({
            kind: 'arrangement',
            grantId: g.id,
            askedBy: getAccount(db, g.delegateAccount)?.displayName ?? 'someone',
            covers: g.categories.map((c) => humanCategory(c)).join(', '),
            limit: money(g.spendCapCents),
          })),
        ],
      };
    },
  },
  {
    name: 'agree_to_visit',
    title: 'Agree to a visit',
    description: 'The person at home agrees to a visit that was waiting on them.',
    audience: 'household',
    touchRoute: '/waiting',
    writes: true,
    // Agreeing is the household's own consent. `acceptPendingVisit` refuses a visit at
    // another home outright; the gate here is what stops a delegate whose arrangement
    // has ended from reaching the record at all.
    subject: (db, _caller, args) => ({
      household: householdOfVisit(db, args.visitId),
      action: 'read',
    }),
    input: { visitId: z.string() },
    run(db, caller, args) {
      return acceptPendingVisit(db, actorOf(caller), String(args.visitId));
    },
  },
  {
    name: 'ask_for_service',
    title: 'Ask for something to be arranged',
    description:
      'The person at home asks for work they want done. On Behalf records it and passes it to whoever arranges things for that home. It does not book it.',
    audience: 'household',
    touchRoute: '/waiting',
    writes: true,
    // Nothing is arranged by this, so it is not a booking: it records the ask and passes
    // it on. What the gate checks is that the caller may still act in that home at all.
    subject: readsHousehold(),
    input: {
      ...householdArg,
      category: z.enum(CATEGORIES).describe('The kind of work.'),
      note: z.string().describe('What the person said they need, in their own words.'),
    },
    run(db, caller, args) {
      const house = targetHousehold(db, caller, args.household);
      return requestService(
        db,
        actorOf(caller),
        house,
        args.category as (typeof CATEGORIES)[number],
        String(args.note ?? ''),
      );
    },
  },
  {
    name: 'what_changed',
    title: 'What has been changed here',
    description:
      'Everything done at this home and who did it, newest first. Use for "what has my daughter changed" or "what happened last week".',
    audience: 'household',
    touchRoute: '/ledger',
    writes: false,
    subject: readsHousehold(),
    input: {
      ...householdArg,
      days: z.number().int().min(1).max(365).optional().describe('How far back to look.'),
    },
    run(db, caller, args) {
      const house = targetHousehold(db, caller, args.household);
      const days = typeof args.days === 'number' ? args.days : 14;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const entries = auditFor(db, house.id, since).slice(0, 12);
      return {
        ok: true,
        code: entries.length ? 'ledger' : 'nothing_changed',
        facts: { household: house.name, days, count: entries.length },
        rows: entries.map((e) => ({
          on: e.at.slice(0, 10),
          who:
            e.actor === 'system' ? 'On Behalf' : (getAccount(db, e.actor)?.displayName ?? 'someone'),
          what: e.action,
          why: e.reason,
          how: e.surface,
        })),
      };
    },
  },
  {
    name: 'accept_arrangement',
    title: 'Accept an arrangement',
    description:
      'The person at home says the pairing code out loud to accept somebody helping with their household admin.',
    audience: 'household',
    touchRoute: '/arrangement',
    writes: true,
    // The code is matched against the caller's own household in `acceptGrant`, so there
    // is nothing here a grant could authorise: the subject is always the caller's home.
    subject: ownHousehold(),
    input: { code: z.string().describe('The six character code, spoken or typed.') },
    run(db, caller, args) {
      const g = acceptGrant(
        db,
        caller.account,
        String(args.code),
        caller.surface === 'touch' ? 'touch' : 'voice',
      );
      const delegate = getAccount(db, g.delegateAccount);
      return {
        ok: true,
        code: 'arrangement_active',
        facts: {
          delegate: delegate?.displayName ?? 'someone',
          covers: g.categories.map((c) => humanCategory(c)).join(', '),
          limit: money(g.spendCapCents),
          endable: true,
        },
      };
    },
  },
  ...(['paused', 'active', 'revoked'] as const).map<ToolDef>((state) => ({
    name:
      state === 'paused'
        ? 'pause_arrangement'
        : state === 'active'
          ? 'resume_arrangement'
          : 'end_arrangement',
    title:
      state === 'paused'
        ? 'Pause an arrangement'
        : state === 'active'
          ? 'Resume an arrangement'
          : 'End an arrangement',
    description:
      state === 'paused'
        ? 'The person at home pauses somebody else arranging things for them. Visits already booked stand.'
        : state === 'active'
          ? 'The person at home starts a paused arrangement again.'
          : 'The person at home ends an arrangement for good. Only they can do this.',
    audience: 'household',
    touchRoute: '/arrangement',
    writes: true,
    // Pausing, resuming and ending are the subject household's alone. `setGrantState`
    // refuses a grant whose `subjectHousehold` is not the caller's, so the subject here
    // is always the caller's own home and no arrangement can authorise it.
    subject: ownHousehold(),
    input: { grantId: z.string().optional().describe('Leave empty when there is only one.') },
    run(db, caller, args) {
      const grants = grantsOverHousehold(db, caller.household.id).filter((g) =>
        state === 'active' ? g.status === 'paused' : g.status === 'active',
      );
      const chosen = args.grantId
        ? grants.find((g) => g.id === args.grantId)
        : grants.length === 1
          ? grants[0]
          : undefined;
      if (!chosen) {
        return {
          ok: false,
          code: grants.length ? 'which_one' : 'nothing_to_change',
          facts: { count: grants.length },
          options: grants.map((g) => ({
            grantId: g.id,
            delegate: getAccount(db, g.delegateAccount)?.displayName ?? 'someone',
          })),
        };
      }
      const g = setGrantState(db, caller.account, chosen.id, state);
      return {
        ok: true,
        code: `arrangement_${state}`,
        facts: {
          delegate: getAccount(db, g.delegateAccount)?.displayName ?? 'someone',
          household: caller.household.name,
          bookedVisitsStand: state !== 'active',
        },
      };
    },
  })),
];
