// The handover note.
//
// This is the piece that replaces the thing Alexa+ cannot do. An add-on cannot speak
// first, so the adult child is never told anything at the moment it happens. What they
// get instead is a written note that reads the ledger for them: what moved, what is
// waiting, what to expect, and what they should probably ring about.
//
// The ledger is already in plain sentences, so the model's job is not to translate it.
// It is to put the three things that matter at the top and leave out the rest, which
// is a judgement no template makes well.

import type { Db } from '../db.ts';
import type { Account, Household } from '../types.ts';
import { ask } from './client.ts';
import { auditFor, getProvider, upcomingVisits } from '../domain/store.ts';
import { pendingFor } from '../domain/decisions.ts';
import { nowIso, readableWhen } from '../clock.ts';
import { money } from '../domain/readback.ts';
import { stripControls } from '../domain/escape.ts';

const SYSTEM = `You write a short note to one adult about another adult's household.

The reader is not in charge of that household. They help with trades, deliveries and
repairs, on terms the household set. Write as though the household will read it too,
because they can: everything you are given is in their own ledger.

Rules:
- Under 160 words. No headings, no bullet list longer than four lines.
- Lead with anything waiting on the reader. Then what changed. Then what is coming.
- Never speculate about health, wellbeing, capacity or whether someone is coping.
- Do not tell the reader to check on anyone. State facts and stop.
- Plain sentences. No em dashes.`;

export interface BriefInput {
  householdName: string;
  timezone: string;
  delegateName: string;
  waiting: string[];
  changed: string[];
  coming: string[];
}

export function gatherBrief(db: Db, delegate: Account, house: Household): BriefInput {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  return {
    householdName: house.name,
    timezone: house.timezone,
    delegateName: delegate.displayName,
    waiting: pendingFor(db, delegate)
      .filter((p) => p.house.id === house.id)
      .map(
        (p) =>
          `${p.provider.name} for ${p.visit.summary}, ${money(p.visit.priceCents)}, asked for by ${p.askedBy.displayName}`,
      ),
    changed: auditFor(db, house.id, since)
      .filter((a) => a.action.startsWith('visit.') || a.action.startsWith('grant.'))
      .slice(0, 10)
      .map((a) => `${a.at.slice(0, 10)}: ${a.reason}`),
    coming: upcomingVisits(db, house.id, nowIso())
      .slice(0, 5)
      .map((v) => {
        const p = getProvider(db, v.providerId);
        return `${p?.name ?? 'a provider'} on ${readableWhen(v.startsAt, house.timezone)} for ${v.summary}`;
      }),
  };
}

/** The plain list, used when Bedrock is unreachable. It is worse, and it is honest. */
export function fallbackBrief(i: BriefInput): string {
  const lines = [`${i.householdName}, as it stands today.`, ''];
  if (i.waiting.length) {
    lines.push('Waiting on you:', ...i.waiting.map((w) => `- ${w}`), '');
  }
  if (i.changed.length) {
    lines.push('Changed in the last two weeks:', ...i.changed.map((c) => `- ${c}`), '');
  }
  if (i.coming.length) {
    lines.push('Coming up:', ...i.coming.map((c) => `- ${c}`));
  }
  if (!i.waiting.length && !i.changed.length && !i.coming.length) {
    lines.push('Nothing has changed and nothing is booked.');
  }
  return lines.join('\n').trim();
}

export interface BriefResult {
  body: string;
  fromFallback: boolean;
  model: string | null;
  latencyMs: number;
}

export async function writeBrief(i: BriefInput): Promise<BriefResult> {
  const user = [
    `Household: ${i.householdName}`,
    `Reader: ${i.delegateName}`,
    '',
    `Waiting on the reader:\n${i.waiting.map((w) => `- ${w}`).join('\n') || '- nothing'}`,
    '',
    `Changed recently:\n${i.changed.map((c) => `- ${c}`).join('\n') || '- nothing'}`,
    '',
    `Coming up:\n${i.coming.map((c) => `- ${c}`).join('\n') || '- nothing'}`,
  ].join('\n');

  try {
    const reply = await ask({ system: SYSTEM, user, maxTokens: 500, temperature: 0.3 });
    return {
      // The ingest floor from §4 of the guard standard: before this string is persisted
      // it loses C0/C1 controls, ANSI escapes, bidi controls and the zero-width family.
      // None of them mean anything in any destination this body reaches, and every one
      // of them is a way to carry something past a guard that has already run. Newlines
      // are kept because the brief is deliberately several short paragraphs.
      body: stripControls(reply.text).trim(),
      fromFallback: false,
      model: reply.model,
      latencyMs: reply.latencyMs,
    };
  } catch {
    return { body: fallbackBrief(i), fromFallback: true, model: null, latencyMs: 0 };
  }
}
