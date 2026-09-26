// The tools the adult child's own Echo and console call.
//
// The asymmetry here is the point. The delegate gets search, booking and decisions.
// The household gets the diary, the ledger and the off switch. Neither set can reach
// the other's, and the capability engine, not this file, is what enforces it.

import { z } from 'zod';
import type { ToolDef } from './registry.ts';
import { householdArg } from './registry.ts';
import { householdOfChange, ownHousehold, readsHousehold, targetHousehold } from './authorize.ts';
import {
  allProviders,
  getAccount,
  getHousehold,
  getProvider,
  liveGrantsForDelegate,
  providersFor,
  upcomingVisits,
} from '../domain/store.ts';
import { row } from '../db.ts';
import { bookVisit } from '../domain/visits.ts';
import { decideRequest, pendingFor } from '../domain/decisions.ts';
import { findSlots } from '../domain/availability.ts';
import { addHours, dayName, hourWord, nowIso, readableTime } from '../clock.ts';
import { money } from '../domain/readback.ts';
import { humanCategory } from '../domain/capability.ts';
import { CATEGORIES } from '../types.ts';
import { StandbyError } from '../domain/grants.ts';
import { forVoice, stripControls } from '../domain/escape.ts';

const actorOf = (caller: { account: import('../types.ts').Account; surface: string }) => ({
  account: caller.account,
  surface: (caller.surface === 'touch' ? 'touch' : 'voice') as 'voice' | 'touch',
});

export const delegateTools: ToolDef[] = [
  {
    name: 'list_on_behalf_households',
    title: 'Homes I act on behalf of',
    description:
      'The other homes this account may act in, what each arrangement covers, and whether it is live.',
    audience: 'delegate',
    touchRoute: '/standby',
    writes: false,
    // This lists the caller's own arrangements, so the subject is their own home and
    // there is nothing for a grant to authorise. What it must not do is name a home the
    // caller can no longer reach, which is a filter on the rows rather than a gate.
    subject: ownHousehold(),
    input: {},
    run(db, caller) {
      // `grantsForDelegate` returns every row of every status, and this tool used to read
      // it. A revoked arrangement still named the other household, the terms it used to
      // carry and the date of its next visit; a `proposed` one did the same before anybody
      // had agreed to anything. Ending an arrangement from the household's own speaker is
      // the control this product exists to sell, so it has to end the reading too.
      const grants = liveGrantsForDelegate(db, caller.account.id);
      return {
        ok: true,
        code: grants.length ? 'households' : 'no_arrangements',
        facts: { count: grants.length },
        rows: grants.map((g) => {
          const h = getHousehold(db, g.subjectHousehold);
          return {
            household: h?.name ?? 'a home',
            state: g.status,
            covers: g.categories.map((c) => humanCategory(c)).join(', '),
            limit: money(g.spendCapCents),
            noticeHours: g.noticeHours,
            hours: `${hourWord(g.earliestHour)} to ${hourWord(g.latestHour)}`,
            accepted: g.acceptedAt ? g.acceptedAt.slice(0, 10) : 'not yet',
            nextVisit: h
              ? (upcomingVisits(db, h.id, nowIso())[0]?.startsAt.slice(0, 10) ?? 'nothing booked')
              : 'nothing booked',
          };
        }),
      };
    },
  },
  {
    name: 'find_provider',
    title: 'Find someone',
    description:
      'Providers for a kind of work, with their next free times at a given home. Does not book anything.',
    audience: 'delegate',
    touchRoute: '/providers',
    writes: false,
    subject: readsHousehold(),
    input: {
      ...householdArg,
      category: z.enum(CATEGORIES).describe('The kind of work needed.'),
    },
    run(db, caller, args) {
      const house = targetHousehold(db, caller, args.household);
      const grant = liveGrantsForDelegate(db, caller.account.id).find(
        (g) => g.subjectHousehold === house.id && g.status === 'active',
      );
      const found = providersFor(db, String(args.category));
      return {
        ok: found.length > 0,
        code: found.length ? 'providers' : 'none_for_category',
        facts: {
          household: house.name,
          category: humanCategory(String(args.category)),
          withinArrangement: grant
            ? grant.categories.includes(args.category as never)
            : false,
        },
        rows: found.map((p) => {
          const next = findSlots(db, {
            provider: p,
            householdId: house.id,
            timezone: house.timezone,
            // Start looking after the notice the household asked for, so a delegate is
            // never offered a time the arrangement would then hold.
            fromIso: grant ? addHours(nowIso(), grant.noticeHours) : nowIso(),
            days: 14,
            earliestHour: grant?.earliestHour,
            latestHour: grant?.latestHour,
            limit: 2,
          });
          return {
            providerId: p.id,
            provider: p.name,
            price: money(p.ratePerVisitCents),
            cancellationPolicy: p.cancellationPolicy,
            // The provider's phone number is deliberately absent. It goes in the
            // confirmation email, never to a speaker. Policy Requirement 3.
            nextDay: next[0] ? dayName(next[0].startsAt, house.timezone) : 'nothing free',
            nextTime: next[0] ? readableTime(next[0].startsAt, house.timezone) : 'nothing free',
            nextStartsAt: next[0]?.startsAt ?? null,
            alsoFree: next[1]
              ? `${dayName(next[1].startsAt, house.timezone)} at ${readableTime(next[1].startsAt, house.timezone)}`
              : 'nothing else in the next two weeks',
          };
        }),
      };
    },
  },
  {
    name: 'book_visit',
    title: 'Book a visit',
    description:
      'Book a provider into another home at a time find_provider returned. Checks the arrangement first, and may hold the booking for the household to agree.',
    audience: 'delegate',
    touchRoute: '/providers',
    writes: true,
    subject: readsHousehold('book'),
    input: {
      ...householdArg,
      providerId: z.string(),
      startsAt: z.string().describe('A time find_provider returned.'),
      summary: z.string().describe('What the work is, in plain words.'),
    },
    run(db, caller, args) {
      const house = targetHousehold(db, caller, args.household);
      const provider = getProvider(db, String(args.providerId));
      if (!provider) throw new StandbyError('unknown_provider', 'On Behalf does not know that one.');
      return bookVisit(db, actorOf(caller), {
        house,
        provider,
        summary: String(args.summary ?? ''),
        startsAt: String(args.startsAt),
      });
    },
  },
  {
    name: 'pending_decisions',
    title: 'Waiting on me',
    description:
      'Requests from the homes this account stands by for that are waiting on a decision, with the reasoning already prepared.',
    audience: 'delegate',
    touchRoute: '/decisions',
    writes: false,
    // `pendingFor` selects on the caller's own active grants, so the subject is the
    // caller's home and the reachability question is answered inside the query.
    subject: ownHousehold(),
    input: {},
    run(db, caller) {
      const items = pendingFor(db, caller.account);
      return {
        ok: true,
        code: items.length ? 'pending' : 'nothing_pending',
        facts: { count: items.length },
        rows: items.map((p) => ({
          changeId: p.change.id,
          household: p.house.name,
          askedBy: p.askedBy.displayName,
          provider: p.provider.name,
          service: p.visit.summary,
          price: money(p.visit.priceCents),
          day: dayName(p.visit.startsAt, p.house.timezone),
          time: readableTime(p.visit.startsAt, p.house.timezone),
          whyWaiting: p.change.holdReason ?? '',
          recommendation: p.change.adjudication?.recommendation ?? 'not yet reviewed',
          headline: p.change.adjudication?.headline ?? '',
        })),
      };
    },
  },
  {
    name: 'decide_request',
    title: 'Decide',
    description:
      'Approve or decline a held request. Approving books it if the arrangement allows; declining tells the household nothing is being arranged.',
    audience: 'delegate',
    touchRoute: '/decisions',
    writes: true,
    // `decideRequest` authorises the booking itself, with the price and the hour, which
    // is where a hold is composed. The gate asks the narrower question first: may this
    // caller still act in the home the request belongs to.
    subject: (db, _caller, args) => ({
      household: householdOfChange(db, args.changeId),
      action: 'read',
    }),
    input: {
      changeId: z.string(),
      verdict: z.enum(['approve', 'decline']),
    },
    run(db, caller, args) {
      return decideRequest(
        db,
        actorOf(caller),
        String(args.changeId),
        args.verdict as 'approve' | 'decline',
      );
    },
  },
  {
    name: 'latest_brief',
    title: 'Where things stand',
    description:
      'The most recent written summary of another home. Returns what was already written; it never waits on anything.',
    audience: 'delegate',
    touchRoute: '/brief',
    writes: false,
    subject: readsHousehold(),
    input: { ...householdArg },
    run(db, caller, args) {
      const house = targetHousehold(db, caller, args.household);
      const b = row<{ at: string; body: string; fromFallback: number; model: string | null }>(
        db,
        'SELECT at, body, fromFallback, model FROM brief WHERE householdId = ? AND delegateAccount = ?',
        house.id,
        caller.account.id,
      );
      if (!b) return { ok: false, code: 'no_brief_yet', facts: { household: house.name } };
      return {
        ok: true,
        code: 'brief',
        facts: {
          household: house.name,
          writtenOn: b.at.slice(0, 10),
          // Escaped for the destination, and the destination depends on who is asking.
          //
          // The body is the one string in this product that a model wrote, that a SQLite
          // round trip carries past the import-graph rule in
          // `no-model-on-read-path.test.ts`, and whose length nothing chose. On a voice
          // turn it becomes part of an SSML response, so `<` and `&` stop being text, and
          // the cap is what stops a five-hundred-word note being read to somebody who
          // asked how things are.
          //
          // On the console it is a text node in a page that `esc()` already escapes, and
          // escaping it twice would show a reader `&amp;` where the note says "and". A
          // single scrub applied once at the top is the mistake §4 is about; this is the
          // same string with two destinations and two rules.
          body: caller.surface === 'voice' ? forVoice(b.body) : stripControls(b.body),
          writtenByModel: !b.fromFallback,
        },
      };
    },
  },
  {
    name: 'on_behalf_status',
    title: 'What On Behalf is',
    description:
      'What this add-on does for this account, what it will not do, and how to stop it.',
    audience: 'both',
    touchRoute: '/',
    writes: false,
    // Answers what Standby is, for this account, about this account's own home.
    subject: ownHousehold(),
    input: {},
    run(db, caller) {
      const grants = liveGrantsForDelegate(db, caller.account.id);
      const over = db
        .prepare(`SELECT COUNT(*) AS n FROM grant_row WHERE subjectHousehold = ? AND status = 'active'`)
        .get(caller.household.id as never) as { n: number };
      return {
        ok: true,
        code: 'status',
        facts: {
          household: caller.household.name,
          standsByFor: grants.filter((g) => g.status === 'active').length,
          peopleHelpingThisHome: over.n,
          coversHealth: false,
          canBeEndedHere: over.n > 0,
          providerDirectorySize: allProviders(db).length,
          accountsLinked: getAccount(db, caller.account.id) ? 1 : 0,
        },
      };
    },
  },
];
