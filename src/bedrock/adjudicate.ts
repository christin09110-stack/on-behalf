// Arguing a held request, so the person deciding it has something to read.
//
// The judgement here is real and it is not a rule: somebody's mother has asked for
// gutter work, or a booking has come in above the limit she agreed to, and the
// question is whether her son should say yes. The inputs that matter are the terms she
// accepted, what has already happened at her house, and what the request costs.
//
// Three boundaries, all enforced rather than promised:
//  - This never executes anything. `decideRequest` does not read the adjudication, so
//    a model that says "decline" cannot decline anything.
//  - It runs after the turn it relates to has already been answered, so its latency is
//    somebody's inbox, not somebody's speaker.
//  - The model selects; this file composes. Nothing the model writes reaches a person.
//
// That last one is the change worth reading, and the argument for it was sitting in this
// file already. The fallback arm below — the one that runs when Bedrock is unreachable —
// composed its reasons out of the ledger and the hold reason, which is source data this
// app wrote. The model arm took `reasons` and `risks` as ten unconstrained sentences and
// `headline` as two hundred characters of free text, and put them above the button that
// admits a stranger to an eighty-year-old's house. The same file, two shapes, and the
// weaker one on the path that needed the stronger.
//
// So the model now returns three things and none of them is prose: a recommendation from
// a closed set, indexes into the ledger it was shown, and codes from two vocabularies
// this file owns. `renderRisk` and `renderHeadline` hold the English. A model that wants
// to say "her son has already agreed to this" has no field to say it in.

import type { Db } from '../db.ts';
import type { Account, Adjudication } from '../types.ts';
import { ask, firstJson, ModelUnavailable } from './client.ts';
import { auditFor, getChange, saveChange } from '../domain/store.ts';
import { humanCategory } from '../domain/capability.ts';
import { readableWhen } from '../clock.ts';
import { money } from '../domain/readback.ts';
import { pendingFor } from '../domain/decisions.ts';

/** What the headline leads on. The model picks a member; this file writes the sentence. */
export const HEADLINE_FOCUS = [
  'cost',
  'timing',
  'repeat_provider',
  'new_provider',
  'outside_arrangement',
  'household_asked',
] as const;
export type HeadlineFocus = (typeof HEADLINE_FOCUS)[number];

/** The risks this product knows how to talk about. Same contract as the focus above. */
export const RISK_CODES = [
  'above_limit',
  'short_notice',
  'outside_hours',
  'unfamiliar_provider',
  'repeat_of_recent_work',
  'not_covered_by_arrangement',
  'cost_looks_high',
  'ring_the_household',
] as const;
export type RiskCode = (typeof RISK_CODES)[number];

const RISK_WORDS: Record<RiskCode, string> = {
  above_limit:
    'It is above the limit the household set, so they are asked before anything happens.',
  short_notice: 'It is sooner than the notice the household asked for.',
  outside_hours: 'The time falls outside the hours the arrangement keeps visits between.',
  unfamiliar_provider: 'This provider has not been to that house in the recent ledger.',
  repeat_of_recent_work:
    'The same provider appears in the recent ledger, so this may repeat work already done.',
  not_covered_by_arrangement: 'This kind of work is not one the arrangement covers.',
  cost_looks_high: 'The cost is high for this kind of work.',
  ring_the_household: 'A phone call to the household would settle this faster than a decision here.',
};

const SYSTEM = `You advise one adult on requests concerning another adult's home.

The other adult is competent and lives alone. They set the terms of this arrangement
themselves and can end it from their own speaker without asking anyone.

Your job is to help the person deciding, not to decide. If the right answer is to ring the
household and ask, recommend ask_the_household.

Never discuss health, medical appointments, medication or care needs. This arrangement
covers trades, deliveries and household services only. If a request appears to concern
health, recommend "ask_the_household".

You do not write any sentence that a person will read. You choose from what you are given.

"reasonIndexes" are line numbers from the numbered "Recent activity" list, most relevant
first, at most three. Choose only lines that would change someone's mind. Use an empty
list if none of them would.

"headlineFocus" is one of: ${HEADLINE_FOCUS.join(', ')}.
"riskCodes" are from: ${RISK_CODES.join(', ')}. At most three, most important first.

Reply with one JSON object and nothing else:
{"recommendation":"approve"|"decline"|"ask_the_household",
 "headlineFocus":"cost",
 "reasonIndexes":[0],
 "riskCodes":["above_limit"]}`;

export interface AdjudicationInput {
  changeId: string;
  householdName: string;
  timezone: string;
  askedBy: string;
  providerName: string;
  category: string;
  whenIso: string;
  priceCents: number;
  note: string;
  holdReason: string;
  recentLedger: string[];
}

export function gather(db: Db, delegate: Account, changeId: string): AdjudicationInput | null {
  const found = pendingFor(db, delegate).find((p) => p.change.id === changeId);
  if (!found) return null;
  const { change, visit, house, provider, askedBy } = found;
  return {
    changeId: change.id,
    householdName: house.name,
    timezone: house.timezone,
    askedBy: askedBy.displayName,
    providerName: provider.name,
    category: visit.category,
    whenIso: visit.startsAt,
    priceCents: visit.priceCents,
    note: visit.summary,
    holdReason: change.holdReason ?? '',
    recentLedger: auditFor(db, house.id)
      .slice(0, 8)
      .map((a) => `${a.at.slice(0, 10)} ${a.action}: ${a.reason}`),
  };
}

function prompt(i: AdjudicationInput): string {
  return [
    `Household: ${i.householdName}`,
    `Asked by: ${i.askedBy}`,
    `Work: ${humanCategory(i.category)}, described as: ${i.note}`,
    `Provider: ${i.providerName}`,
    `Proposed: ${readableWhen(i.whenIso, i.timezone)}`,
    `Cost: ${money(i.priceCents)}`,
    `Why it is waiting: ${i.holdReason}`,
    '',
    'Recent activity at that house, numbered:',
    ...i.recentLedger.map((l, n) => `[${n}] ${l}`),
  ].join('\n');
}

/** The base sentence: the same one the fallback writes, because it was always right. */
function baseHeadline(i: AdjudicationInput): string {
  return `${i.providerName} for ${humanCategory(i.category).toLowerCase()} at ${i.householdName}, ${money(i.priceCents)}.`;
}

function renderHeadline(i: AdjudicationInput, focus: HeadlineFocus): string {
  const tail: Record<HeadlineFocus, string> = {
    cost: `The cost is the thing to look at.`,
    timing: `${readableWhen(i.whenIso, i.timezone)} is the thing to look at.`,
    repeat_provider: `${i.providerName} has been there recently.`,
    new_provider: `${i.providerName} is new to that house.`,
    outside_arrangement: `It falls outside the arrangement as it was accepted.`,
    household_asked: `${i.askedBy} asked for this at home.`,
  };
  return `${baseHeadline(i)} ${tail[focus]}`;
}

/** S2 of the guard standard: an integer, in range, and not a boolean pretending to be one. */
function decodeIndex(value: unknown, limit: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RangeError(`index: ${JSON.stringify(value)} is not an integer`);
  }
  if (value < 0 || value >= limit) {
    throw new RangeError(`index: ${value} outside 0..${limit - 1}`);
  }
  return value;
}

/** S1: a member of a closed set, or the record is refused. Never coerced to a default. */
function decodeMember<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new RangeError(`not a member of the set: ${JSON.stringify(value)}`);
  }
  return value as T;
}

/**
 * The reasons a person reads, composed here from what the model selected.
 *
 * The first two never come from the model at all: why the request is waiting is the
 * capability engine's own sentence, and who asked for it is a name out of the accounts
 * table. The rest are ledger lines this app wrote, quoted by index.
 */
function composeReasons(i: AdjudicationInput, indexes: number[]): string[] {
  const cited = indexes.map((n) => i.recentLedger[n]!).filter(Boolean);
  return [i.holdReason, `Asked for by ${i.askedBy}.`, ...cited].filter(Boolean);
}

/** Rule-written adjudication, used when Bedrock is unreachable. Never a silent gap. */
export function fallback(i: AdjudicationInput, latencyMs: number): Adjudication {
  const repeats = i.recentLedger.filter((l) => l.includes(i.providerName)).length;
  return {
    recommendation: 'ask_the_household',
    headline: renderHeadline(i, repeats > 0 ? 'repeat_provider' : 'new_provider'),
    reasons: [
      i.holdReason,
      `Asked for by ${i.askedBy}.`,
      repeats > 0
        ? `${i.providerName} appears ${repeats} more ${repeats === 1 ? 'time' : 'times'} in the recent ledger at that house.`
        : `${i.providerName} is new to that house in the recent ledger.`,
    ].filter(Boolean),
    risks: ['Written from the ledger. The summarising model was not reachable.'],
    fromFallback: true,
    model: null,
    latencyMs,
  };
}

/**
 * The whole of what the model contributes, decoded.
 *
 * Exported because the boundary test in `tests/adjudication.test.ts` drives it with the
 * worst thing a model could return and then renders the result: everything between this
 * function and a person is `adjudicationView`, and everything above it is one HTTP call.
 *
 * Every field is decoded and a field that does not decode throws, which refuses the whole
 * record rather than dropping to a default. An unknown member means the model is doing
 * something nobody modelled; the fallback is a complete, honest answer and hiding the
 * surprise behind a default is not.
 */
export function decodeAdjudication(
  input: AdjudicationInput,
  parsed: Record<string, unknown>,
  meta: { model: string; latencyMs: number },
): Adjudication {
  const recommendation = decodeMember(parsed.recommendation, [
    'approve',
    'decline',
    'ask_the_household',
  ] as const);
  const focus = decodeMember(parsed.headlineFocus, HEADLINE_FOCUS);
  const indexes = (Array.isArray(parsed.reasonIndexes) ? parsed.reasonIndexes : [])
    .slice(0, 3)
    .map((v) => decodeIndex(v, input.recentLedger.length));
  const risks = (Array.isArray(parsed.riskCodes) ? parsed.riskCodes : [])
    .slice(0, 3)
    .map((v) => RISK_WORDS[decodeMember(v, RISK_CODES)]);

  return {
    recommendation,
    headline: renderHeadline(input, focus),
    reasons: composeReasons(input, indexes),
    risks,
    fromFallback: false,
    model: meta.model,
    latencyMs: meta.latencyMs,
  };
}

export async function adjudicate(db: Db, input: AdjudicationInput): Promise<Adjudication> {
  let result: Adjudication;
  try {
    const reply = await ask({
      system: SYSTEM,
      user: prompt(input),
      maxTokens: 400,
      prefill: '{',
    });
    result = decodeAdjudication(input, firstJson<Record<string, unknown>>(reply.text), {
      model: reply.model,
      latencyMs: reply.latencyMs,
    });
  } catch (e) {
    result = fallback(input, e instanceof ModelUnavailable ? e.latencyMs : 0);
  }

  const change = getChange(db, input.changeId);
  if (change) {
    change.adjudication = result;
    saveChange(db, change);
  }
  return result;
}
