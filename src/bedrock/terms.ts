// Turning "I handle the boiler and the garden, nothing over two hundred, never before
// ten" into terms a household can actually accept.
//
// The arrangement is the whole product, and it is also the screen people abandon:
// twelve categories, a spend cap, a notice window and two hour fields. So the delegate
// types a sentence and the model proposes the structure. Then two things happen that
// the model has no part in: the delegate edits it, and the other household has to
// accept it on their own device before any of it is real.
//
// So the model drafts a form. It does not grant anything.

import { CATEGORIES, type Category } from '../types.ts';
import { DEFAULT_TERMS, type Terms } from '../domain/grants.ts';
import { screenForHealth } from '../domain/screening.ts';
import { stripControls } from '../domain/escape.ts';
import { ask, firstJson } from './client.ts';

/**
 * Why the model no longer writes the notice, and why that is the whole fix.
 *
 * The prompt used to say: drop anything health-related from the categories and "put a
 * line in `dropped` saying the arrangement does not cover health". So the model authored
 * the safety notice, and a model that authors a safety notice can invert it —
 * *"Nothing was dropped; medication pickups are covered under delivery."* — on the page
 * where somebody decides what another household has agreed to.
 *
 * The app already knows everything the notice says. It knows the sentence mentioned
 * health, because `screenForHealth` is the same screen that refuses the text everywhere
 * else in this product. It knows which category names it threw away, because it threw
 * them away. So there is no field for the model to fill: `dropped` is a list of codes
 * this file computes, and the English belongs to `DROPPED_WORDS` below.
 *
 * The strongest shape on the guard-design ladder is the one where the model
 * has no field at all.
 */
export const DROPPED_CODES = ['health', 'unknown_category', 'nothing_matched'] as const;
export type DroppedCode = (typeof DROPPED_CODES)[number];

const DROPPED_WORDS: Record<DroppedCode, string> = {
  health:
    'On Behalf does not cover health arrangements of any kind, so anything of that sort in ' +
    'what you wrote was left out. There is no health category and there will not be one.',
  unknown_category:
    'Part of what you wrote is not a kind of work On Behalf arranges, so it was left out. ' +
    'What it does cover is listed below.',
  nothing_matched:
    'Nothing in the sentence named a kind of work, so this starts from the usual four. ' +
    'Change them before you send it.',
};

/** The notice a person reads. App-authored, one per code, never model text. */
export function droppedNotice(code: string): string {
  return DROPPED_WORDS[code as DroppedCode] ?? DROPPED_WORDS.unknown_category;
}

const SYSTEM = `You turn one sentence about helping with somebody's house into a
structured arrangement.

Allowed categories, and nothing else: ${CATEGORIES.join(', ')}.

There is no health category and there never will be. If the sentence mentions doctors,
dentists, medication, hospitals or care, leave it out of the categories and say nothing
about it. Standby writes that notice itself.

Be conservative. If the sentence does not mention cancelling, do not grant cancelling.
If it does not name a limit, leave the limit where it is.

Reply with one JSON object and nothing else:
{"categories":["..."],"spendCapCents":25000,"noticeHours":24,"earliestHour":9,
 "latestHour":17,"mayBook":true,"mayReschedule":true,"mayCancel":false}`;

export interface DraftedTerms {
  terms: Terms;
  /** Reason codes. The console renders `droppedNotice(code)`; the model never sees this. */
  dropped: DroppedCode[];
  summary: string;
  fromFallback: boolean;
  model: string | null;
}

/**
 * What was left out, worked out from the sentence and from what survived the allowlist.
 *
 * One function, used by both arms, so the notice cannot differ depending on whether
 * Bedrock answered.
 */
function droppedFrom(sentence: string, kept: readonly Category[], proposed: number): DroppedCode[] {
  const out: DroppedCode[] = [];
  if (!screenForHealth(sentence).clean) out.push('health');
  if (proposed > kept.length) out.push('unknown_category');
  if (kept.length === 0) out.push('nothing_matched');
  return out;
}

const WORD_TO_CATEGORY: Array<[RegExp, Category]> = [
  [/boiler|heating|furnace|radiator/i, 'heating'],
  [/plumb|leak|tap|pipe|drain/i, 'plumbing'],
  [/electric|wiring|socket|fuse/i, 'electrical'],
  [/garden|lawn|hedge|yard/i, 'gardening'],
  [/clean(?!ing the gutters)|cleaner/i, 'cleaning'],
  [/gutter/i, 'gutters'],
  [/window/i, 'window_cleaning'],
  [/chimney|flue/i, 'chimney'],
  [/pest|mice|rats|wasp/i, 'pest_control'],
  [/lock|key|locksmith/i, 'locksmith'],
  [/deliver|parcel|shopping drop/i, 'delivery'],
  [/appliance|washer|dishwasher|fridge|oven/i, 'appliance_repair'],
];

/** Keyword draft. Used when Bedrock is unreachable, and as the shape of the truth. */
export function fallbackTerms(sentence: string): DraftedTerms {
  const categories = WORD_TO_CATEGORY.filter(([re]) => re.test(sentence)).map(([, c]) => c);
  const cap = /(\d{2,5})\s*(dollars|bucks|\$)?/i.exec(sentence.replace(/[,$]/g, ''));
  const hour = /before\s+(\d{1,2})/i.exec(sentence);
  return {
    terms: {
      ...DEFAULT_TERMS,
      categories: categories.length ? categories : DEFAULT_TERMS.categories,
      spendCapCents: cap ? Number(cap[1]) * 100 : DEFAULT_TERMS.spendCapCents,
      earliestHour: hour ? Number(hour[1]) : DEFAULT_TERMS.earliestHour,
      mayCancel: /cancel/i.test(sentence),
    },
    dropped: droppedFrom(sentence, categories, categories.length),
    summary: 'Drafted from the words in the sentence. The model was not reachable.',
    fromFallback: true,
    model: null,
  };
}

/**
 * The drafting summary is the last prose field in this file and it is Band C: it is a
 * caption above a form the delegate then edits, and nothing acts on it. It still gets the
 * health screen, because the page it lands on is the page that says health is not covered.
 */
function summaryOf(value: unknown): string {
  const text = stripControls(String(value ?? ''), false).slice(0, 300);
  return screenForHealth(text).clean ? text : '';
}

function clampHour(n: unknown, fallbackValue: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 && v <= 23 ? Math.floor(v) : fallbackValue;
}

export async function draftTerms(sentence: string): Promise<DraftedTerms> {
  try {
    const reply = await ask({ system: SYSTEM, user: sentence, maxTokens: 600, prefill: '{' });
    const p = firstJson<Record<string, unknown>>(reply.text);
    const cats = (Array.isArray(p.categories) ? p.categories : [])
      .map(String)
      .filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c));
    return {
      terms: {
        ...DEFAULT_TERMS,
        categories: cats.length ? cats : DEFAULT_TERMS.categories,
        spendCapCents:
          Number.isFinite(Number(p.spendCapCents)) && Number(p.spendCapCents) > 0
            ? Math.min(Number(p.spendCapCents), 500_000)
            : DEFAULT_TERMS.spendCapCents,
        noticeHours: clampHour(p.noticeHours, DEFAULT_TERMS.noticeHours),
        earliestHour: clampHour(p.earliestHour, DEFAULT_TERMS.earliestHour),
        latestHour: clampHour(p.latestHour, DEFAULT_TERMS.latestHour),
        mayBook: p.mayBook !== false,
        mayReschedule: p.mayReschedule !== false,
        mayCancel: p.mayCancel === true,
      },
      dropped: droppedFrom(
        sentence,
        cats,
        Array.isArray(p.categories) ? p.categories.length : 0,
      ),
      // The one sentence the model still writes goes through the same screen as anything
      // else it writes, because it is rendered on the page where the terms are accepted.
      summary: summaryOf(p.summary),
      fromFallback: false,
      model: reply.model,
    };
  } catch {
    return fallbackTerms(sentence);
  }
}
