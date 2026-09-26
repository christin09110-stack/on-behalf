// Availability.
//
// MOCK BOUNDARY. There is no real trade-booking API behind Standby. Slots are
// generated from a hash of the provider id and the calendar day, so the same provider
// offers the same slots on the same day on every run, in every test, and in the demo.
// That is a deliberate choice over random data: a judge can rerun the demo and see the
// same Thursday.
//
// It sits here rather than inside the booking code so that the day a real provider API
// arrives, only this file changes. Everything above it already treats a slot as an
// opaque ISO string it did not choose.

import type { Db } from '../db.ts';
import type { Provider } from '../types.ts';
import { occupiedSlots } from './store.ts';
import { addDays, localHour } from '../clock.ts';

/** Working hours the mock directory operates in, local to the household. */
const OPEN_HOUR = 8;
const CLOSE_HOUR = 18;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function dayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(iso));
}

/** Local midnight for a day, expressed as an instant. */
function localMidnight(iso: string, timezone: string): Date {
  const d = new Date(iso);
  const hour = localHour(iso, timezone);
  const minutes = Number(
    new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: timezone }).format(d),
  );
  return new Date(d.getTime() - hour * 3_600_000 - minutes * 60_000);
}

/** 0 = Sunday, in the household's own timezone rather than UTC. */
export function weekdayIndex(iso: string, timezone: string): number {
  const short = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(
    new Date(iso),
  );
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
}

export interface Slot {
  startsAt: string;
  endsAt: string;
}

/**
 * The slots a provider would offer on one local day. Deterministic.
 *
 * A provider is busy in roughly half of its working hours; which half depends only on
 * the provider and the date, never on the clock.
 */
export function slotsOnDay(provider: Provider, dayIso: string, timezone: string): Slot[] {
  const base = localMidnight(dayIso, timezone);
  const seed = hash(`${provider.id}:${dayKey(dayIso, timezone)}`);
  const weekday = weekdayIndex(dayIso, timezone);
  const out: Slot[] = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    // Sunday is closed for every provider in the mock directory.
    if (weekday === 0) break;
    const bit = (seed >>> (h - OPEN_HOUR)) & 1;
    if (bit === 0) continue;
    const startsAt = new Date(base.getTime() + h * 3_600_000).toISOString();
    out.push({ startsAt, endsAt: new Date(base.getTime() + (h + 1) * 3_600_000).toISOString() });
  }
  return out;
}

export interface SlotQuery {
  provider: Provider;
  householdId: string;
  timezone: string;
  /** Start looking from here. */
  fromIso: string;
  /** How many days forward to look. */
  days: number;
  /** Only offer slots on this weekday, when the household named one. */
  onlyWeekday?: number;
  /** Refuse slots outside these local hours, when a grant constrains them. */
  earliestHour?: number;
  latestHour?: number;
  limit?: number;
}

/**
 * Free slots, with anything the household already has in the diary removed.
 * Pure reads against a local file, so it stays inside the round-trip budget.
 */
export function findSlots(db: Db, q: SlotQuery): Slot[] {
  const taken = new Set(occupiedSlots(db, q.householdId, q.fromIso));
  const out: Slot[] = [];
  for (let d = 0; d < q.days && out.length < (q.limit ?? 3); d++) {
    const day = addDays(q.fromIso, d);
    if (q.onlyWeekday !== undefined && weekdayIndex(day, q.timezone) !== q.onlyWeekday) continue;
    for (const s of slotsOnDay(q.provider, day, q.timezone)) {
      if (s.startsAt <= q.fromIso) continue;
      if (taken.has(s.startsAt)) continue;
      const hour = localHour(s.startsAt, q.timezone);
      if (q.earliestHour !== undefined && hour < q.earliestHour) continue;
      if (q.latestHour !== undefined && hour >= q.latestHour) continue;
      out.push(s);
      if (out.length >= (q.limit ?? 3)) break;
    }
  }
  return out;
}
