// Seed data.
//
// MOCK BOUNDARY, stated plainly: none of these people, homes or trades exist, and
// there is no provider API behind the directory. The shapes are real (two separately
// linked accounts, one arrangement, a diary, a provider list with genuine cancellation
// terms) and everything above this file treats them as if they came from somewhere
// else.
//
// The two homes are in different US timezones on purpose. It is the case that breaks
// naive scheduling code, and it is also true of most families who do this.

import { openDb, defaultDbPath, type Db } from './db.ts';
import type { Account, Household, Provider, Visit } from './types.ts';
import { saveProvider, saveVisit } from './domain/store.ts';
import { proposeGrant, acceptGrant, DEFAULT_TERMS } from './domain/grants.ts';
import { findSlots } from './domain/availability.ts';
import { addDays, addHours, nowIso, setFixedNow } from './clock.ts';
import { bookVisit, requestService } from './domain/visits.ts';
import { deliver } from './domain/outbox.ts';
import { reference } from './ids.ts';

export const RIDGEWAY: Household = {
  id: 'house_ridgeway',
  name: 'Ridgeway',
  timezone: 'America/New_York',
  areaLabel: 'the east side of town',
};

export const CALDER: Household = {
  id: 'house_calder',
  name: 'Calder Street',
  timezone: 'America/Los_Angeles',
  areaLabel: 'two thousand miles away',
};

export const MARIAN: Account = {
  id: 'acct_marian',
  linkedSubject: 'amzn1.account.MARIAN000000000000000000',
  displayName: 'Marian',
  householdId: RIDGEWAY.id,
  email: 'marian@ridgeway.invalid',
  sms: '+15550100001',
};

export const NADIA: Account = {
  id: 'acct_nadia',
  linkedSubject: 'amzn1.account.NADIA0000000000000000000',
  displayName: 'Nadia',
  householdId: CALDER.id,
  email: 'nadia@calder.invalid',
  sms: '+15550100002',
};

export const PROVIDERS: Provider[] = [
  {
    id: 'prov_halloran',
    name: 'Halloran Plumbing',
    category: 'plumbing',
    phone: '+15550111001',
    cancellationPolicy: 'Free to cancel up to 24 hours before. After that, half the call-out fee.',
    cancellationFeeCents: 4_500,
    freeCancelHours: 24,
    ratePerVisitCents: 9_000,
  },
  {
    id: 'prov_bellweather',
    name: 'Bellweather Heating',
    category: 'heating',
    phone: '+15550111002',
    cancellationPolicy: 'Free to cancel up to 48 hours before. Inside that, a 60 dollar charge.',
    cancellationFeeCents: 6_000,
    freeCancelHours: 48,
    ratePerVisitCents: 18_000,
  },
  {
    id: 'prov_quill',
    name: 'Quill Electrical',
    category: 'electrical',
    phone: '+15550111003',
    cancellationPolicy: 'Free to cancel any time before the day of the visit.',
    cancellationFeeCents: 3_000,
    freeCancelHours: 12,
    ratePerVisitCents: 14_000,
  },
  {
    id: 'prov_marden',
    name: 'Marden Appliance Repair',
    category: 'appliance_repair',
    phone: '+15550111004',
    cancellationPolicy: 'Free to cancel up to 24 hours before. After that, the 55 dollar call-out stands.',
    cancellationFeeCents: 5_500,
    freeCancelHours: 24,
    ratePerVisitCents: 12_000,
  },
  {
    id: 'prov_thistle',
    name: 'Thistle Garden Care',
    category: 'gardening',
    phone: '+15550111005',
    cancellationPolicy: 'Cancel any time up to the morning of the visit, at no charge.',
    cancellationFeeCents: 0,
    freeCancelHours: 6,
    ratePerVisitCents: 7_500,
  },
  {
    id: 'prov_lumen',
    name: 'Lumen Window Cleaning',
    category: 'window_cleaning',
    phone: '+15550111006',
    cancellationPolicy: 'No charge to cancel, ever. They ask for a day of notice as a courtesy.',
    cancellationFeeCents: 0,
    freeCancelHours: 0,
    ratePerVisitCents: 5_000,
  },
  {
    id: 'prov_rookery',
    name: 'Rookery Gutter Works',
    category: 'gutters',
    phone: '+15550111007',
    cancellationPolicy: 'Free to cancel up to 24 hours before. Inside that, a 40 dollar charge.',
    cancellationFeeCents: 4_000,
    freeCancelHours: 24,
    ratePerVisitCents: 22_000,
  },
  {
    id: 'prov_ashgrove',
    name: 'Ashgrove Chimney',
    category: 'chimney',
    phone: '+15550111008',
    cancellationPolicy: 'Free to cancel up to 72 hours before. Inside that, a 75 dollar charge.',
    cancellationFeeCents: 7_500,
    freeCancelHours: 72,
    ratePerVisitCents: 26_000,
  },
  {
    id: 'prov_penrose',
    name: 'Penrose Home Cleaning',
    category: 'cleaning',
    phone: '+15550111009',
    cancellationPolicy: 'Free to cancel up to 24 hours before. After that, one hour is charged.',
    cancellationFeeCents: 3_500,
    freeCancelHours: 24,
    ratePerVisitCents: 11_000,
  },
  {
    id: 'prov_kestrel',
    name: 'Kestrel Pest Control',
    category: 'pest_control',
    phone: '+15550111010',
    cancellationPolicy: 'Free to cancel up to 48 hours before. Inside that, half the visit fee.',
    cancellationFeeCents: 6_500,
    freeCancelHours: 48,
    ratePerVisitCents: 13_000,
  },
  {
    id: 'prov_vane',
    name: 'Vane Locksmiths',
    category: 'locksmith',
    phone: '+15550111011',
    cancellationPolicy: 'No charge to cancel. Call-outs are quoted on arrival.',
    cancellationFeeCents: 0,
    freeCancelHours: 0,
    ratePerVisitCents: 8_500,
  },
  {
    id: 'prov_coldharbour',
    name: 'Coldharbour Deliveries',
    category: 'delivery',
    phone: '+15550111012',
    cancellationPolicy: 'Free to cancel up to two hours before the delivery window.',
    cancellationFeeCents: 0,
    freeCancelHours: 2,
    ratePerVisitCents: 2_000,
  },
  {
    id: 'prov_seabright',
    name: 'Seabright Plumbing and Drains',
    category: 'plumbing',
    phone: '+15550111013',
    cancellationPolicy: 'Free to cancel up to 12 hours before. Inside that, a 30 dollar charge.',
    cancellationFeeCents: 3_000,
    freeCancelHours: 12,
    ratePerVisitCents: 11_500,
  },
  {
    id: 'prov_warrender',
    name: 'Warrender Boiler Service',
    category: 'heating',
    phone: '+15550111014',
    cancellationPolicy: 'Free to cancel up to 24 hours before. Inside that, a 45 dollar charge.',
    cancellationFeeCents: 4_500,
    freeCancelHours: 24,
    ratePerVisitCents: 14_500,
  },
  {
    id: 'prov_saltmarsh',
    name: 'Saltmarsh Lawns',
    category: 'gardening',
    phone: '+15550111015',
    cancellationPolicy: 'Cancel any time before the crew sets off, at no charge.',
    cancellationFeeCents: 0,
    freeCancelHours: 2,
    ratePerVisitCents: 6_000,
  },
  {
    id: 'prov_tolliver',
    name: 'Tolliver Appliance Care',
    category: 'appliance_repair',
    phone: '+15550111016',
    cancellationPolicy: 'Free to cancel up to 48 hours before. Inside that, the call-out is charged.',
    cancellationFeeCents: 6_500,
    freeCancelHours: 48,
    ratePerVisitCents: 15_500,
  },
];

export interface Seeded {
  db: Db;
  grantId: string;
}

/**
 * Build a whole world. Used by the demo, the console and every test that needs more
 * than one row, so the demo and the tests cannot drift apart.
 */
export function seed(
  db: Db,
  opts: { withVisits?: boolean; accept?: boolean; propose?: boolean } = {},
): Seeded {
  for (const h of [RIDGEWAY, CALDER]) {
    db.prepare('INSERT OR REPLACE INTO household VALUES (?,?,?,?)').run(
      h.id,
      h.name,
      h.timezone,
      h.areaLabel,
    );
  }
  for (const a of [MARIAN, NADIA]) {
    db.prepare('INSERT OR REPLACE INTO account VALUES (?,?,?,?,?,?)').run(
      a.id,
      a.linkedSubject,
      a.displayName,
      a.householdId,
      a.email,
      a.sms,
    );
  }
  for (const p of PROVIDERS) saveProvider(db, p);

  if (opts.propose === false) return { db, grantId: '' };

  const grant = proposeGrant(db, NADIA, RIDGEWAY, {
    ...DEFAULT_TERMS,
    categories: ['plumbing', 'heating', 'appliance_repair', 'gardening', 'gutters'],
    spendCapCents: 20_000,
    noticeHours: 24,
    earliestHour: 9,
    latestHour: 17,
    mayCancel: true,
  });
  if (opts.accept !== false) {
    acceptGrant(db, MARIAN, grant.pairingCode!, 'voice');
  }

  if (opts.withVisits !== false) {
    const plumber = PROVIDERS[0]!;
    const gardener = PROVIDERS[4]!;
    for (const [provider, summary, dayOffset] of [
      [plumber, 'the dripping tap in the kitchen', 3],
      [gardener, 'cutting the hedge at the front', 5],
    ] as const) {
      const slot = findSlots(db, {
        provider,
        householdId: RIDGEWAY.id,
        timezone: RIDGEWAY.timezone,
        fromIso: addDays(nowIso(), dayOffset),
        days: 7,
        earliestHour: 9,
        latestHour: 17,
        limit: 1,
      })[0];
      if (!slot) continue;
      const v: Visit = {
        id: `visit_seed_${provider.id}`,
        householdId: RIDGEWAY.id,
        providerId: provider.id,
        category: provider.category,
        summary,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: 'booked',
        priceCents: provider.ratePerVisitCents,
        reference: reference(),
        arrangedBy: NADIA.id,
        arrangedAt: nowIso(),
        previousStartsAt: null,
      };
      saveVisit(db, v);
    }

    // One visit at the delegate's own home too, because a household that runs
    // somebody else's admin still has its own, and the console should not look like
    // a one-sided tool.
    const cleaner = PROVIDERS.find((p) => p.id === 'prov_penrose')!;
    const own = findSlots(db, {
      provider: cleaner,
      householdId: CALDER.id,
      timezone: CALDER.timezone,
      fromIso: addDays(nowIso(), 2),
      days: 7,
      limit: 1,
    })[0];
    if (own) {
      saveVisit(db, {
        id: 'visit_seed_calder',
        householdId: CALDER.id,
        providerId: cleaner.id,
        category: cleaner.category,
        summary: 'the fortnightly clean',
        startsAt: own.startsAt,
        endsAt: own.endsAt,
        status: 'booked',
        priceCents: cleaner.ratePerVisitCents,
        reference: reference(),
        arrangedBy: NADIA.id,
        arrangedAt: nowIso(),
        previousStartsAt: null,
      });
    }
  }

  return { db, grantId: grant.id };
}

/**
 * A few turns on top of the seed, so every page in the console has something real on
 * it. Run with `npm run seed -- --story`.
 */
export function story(db: Db): void {
  const marian = { account: MARIAN, surface: 'voice' as const };
  const nadia = { account: NADIA, surface: 'touch' as const };

  // Marian asks for something at her own house. It waits for Nadia.
  requestService(db, marian, RIDGEWAY, 'gutters', 'the gutter over the back door is overflowing');

  // Nadia arranges a boiler service at the first slot there is, which falls inside the
  // day of notice Marian asked for, so it waits for her rather than going ahead.
  const boiler = PROVIDERS.find((p) => p.id === 'prov_bellweather')!;
  const soon = findSlots(db, {
    provider: boiler,
    householdId: RIDGEWAY.id,
    timezone: RIDGEWAY.timezone,
    fromIso: nowIso(),
    days: 2,
    limit: 1,
  })[0];
  bookVisit(db, nadia, {
    house: RIDGEWAY,
    provider: boiler,
    summary: 'the boiler is making a noise upstairs',
    startsAt: soon?.startsAt ?? addHours(nowIso(), 6),
  });

  deliver(db);
}

export function seedFresh(path = defaultDbPath()): Seeded {
  const db = openDb(path);
  for (const t of [
    'audit',
    'outbox',
    'change_request',
    'visit',
    'grant_row',
    'provider',
    'account',
    'household',
    'oauth_code',
    'oauth_token',
    'brief',
  ]) {
    db.exec(`DELETE FROM ${t}`);
  }
  return seed(db);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  setFixedNow(null);
  const { db } = seedFresh();
  let extra = '';
  if (process.argv.includes('--story')) {
    story(db);
    extra = ', plus one request waiting on each side';
  }
  process.stdout.write(
    `Seeded ${defaultDbPath()}: two homes, ${PROVIDERS.length} providers, one arrangement${extra}.\n`,
  );
  db.close();
}
