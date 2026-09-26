// The written channel.
//
// This is not a nicety bolted on the side. An Alexa+ add-on cannot speak first: the
// Conversation Surface page says the model is turn-based and the add-on "participates
// one turn at a time", and nothing in the permissions, lifecycle or certification pages
// documents a server-initiated route to a customer. So the only way Standby can tell
// the adult child that their mother moved Thursday is from its own backend.
//
// Policy Requirement 15 turns that from a workaround into an obligation: "Provide
// post-booking confirmation via voice AND at least one written channel (email, SMS, or
// home card)." Every booking, move and cancellation here writes both ends a message.
//
// MOCK BOUNDARY: there is no mail or SMS provider wired up. `deliver` writes each
// message to `data/outbox/` as a file you can open and marks the row sent. The message
// bodies are real; the transport is not, and the console labels it as such.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import type { OutboxChannel, OutboxMessage } from '../types.ts';
import { queuedOutbox, saveOutbox } from './store.ts';
import { id } from '../ids.ts';
import { nowIso } from '../clock.ts';

export interface Draft {
  channel: OutboxChannel;
  to: string;
  subject: string;
  body: string;
  kind: string;
  relatedVisit?: string | null;
}

export function queue(db: Db, d: Draft): OutboxMessage {
  const m: OutboxMessage = {
    id: id('msg'),
    at: nowIso(),
    channel: d.channel,
    to: d.to,
    subject: d.subject,
    body: d.body,
    status: 'queued',
    attempts: 0,
    lastError: null,
    relatedVisit: d.relatedVisit ?? null,
    kind: d.kind,
  };
  saveOutbox(db, m);
  return m;
}

export interface DeliveryReport {
  sent: number;
  failed: number;
  messages: OutboxMessage[];
}

/**
 * Attempt every queued message once.
 *
 * `STANDBY_OUTBOX_FAIL` makes the fake transport reject any recipient containing that
 * string, which is how the retry path gets exercised in the demo and in tests rather
 * than only existing in theory.
 */
export function deliver(db: Db, dir = defaultOutboxDir()): DeliveryReport {
  mkdirSync(dir, { recursive: true });
  const failOn = process.env.STANDBY_OUTBOX_FAIL;
  const report: DeliveryReport = { sent: 0, failed: 0, messages: [] };

  for (const m of queuedOutbox(db)) {
    m.attempts += 1;
    if (failOn && m.to.includes(failOn) && m.attempts < 3) {
      m.status = 'queued';
      m.lastError = `the fake transport rejected ${m.to} on attempt ${m.attempts}`;
      report.failed += 1;
    } else {
      const ext = m.channel === 'email' ? 'eml' : 'txt';
      const file = join(dir, `${m.at.replace(/[:.]/g, '-')}-${m.kind}-${m.id}.${ext}`);
      writeFileSync(file, render(m), 'utf8');
      m.status = 'sent';
      m.lastError = null;
      report.sent += 1;
    }
    saveOutbox(db, m);
    report.messages.push(m);
  }
  return report;
}

export function render(m: OutboxMessage): string {
  if (m.channel === 'sms') return `To: ${m.to}\n\n${m.body}\n`;
  return [
    `From: On Behalf <no-reply@standby.invalid>`,
    `To: ${m.to}`,
    `Subject: ${m.subject}`,
    `Date: ${m.at}`,
    `X-Standby-Kind: ${m.kind}`,
    `X-Standby-Transport: mock`,
    '',
    m.body,
    '',
  ].join('\n');
}

export function defaultOutboxDir(): string {
  return (
    process.env.STANDBY_OUTBOX_DIR ?? new URL('../../data/outbox', import.meta.url).pathname
  );
}
