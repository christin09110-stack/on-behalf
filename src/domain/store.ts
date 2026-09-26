// Typed reads and writes. Nothing here decides anything; the rules live next door.

import type { Db } from '../db.ts';
import { row, rows } from '../db.ts';
import type {
  Account,
  AuditEntry,
  ChangeRequest,
  Grant,
  Household,
  OutboxMessage,
  Provider,
  Visit,
  Category,
} from '../types.ts';
import { id } from '../ids.ts';
import { nowIso } from '../clock.ts';

type GrantRow = Omit<Grant, 'categories' | 'mayBook' | 'mayReschedule' | 'mayCancel'> & {
  categories: string;
  mayBook: number;
  mayReschedule: number;
  mayCancel: number;
};

const toGrant = (r: GrantRow): Grant => ({
  ...r,
  categories: JSON.parse(r.categories) as Category[],
  mayBook: !!r.mayBook,
  mayReschedule: !!r.mayReschedule,
  mayCancel: !!r.mayCancel,
});

export const getHousehold = (db: Db, id_: string): Household | null =>
  row<Household>(db, 'SELECT * FROM household WHERE id = ?', id_);

export const allHouseholds = (db: Db): Household[] =>
  rows<Household>(db, 'SELECT * FROM household ORDER BY name');

export const getAccount = (db: Db, id_: string): Account | null =>
  row<Account>(db, 'SELECT * FROM account WHERE id = ?', id_);

export const accountBySubject = (db: Db, subject: string): Account | null =>
  row<Account>(db, 'SELECT * FROM account WHERE linkedSubject = ?', subject);

export const allAccounts = (db: Db): Account[] =>
  rows<Account>(db, 'SELECT * FROM account ORDER BY displayName');

export const accountsIn = (db: Db, householdId: string): Account[] =>
  rows<Account>(db, 'SELECT * FROM account WHERE householdId = ?', householdId);

export function saveGrant(db: Db, g: Grant): void {
  db.prepare(
    `INSERT INTO grant_row (id, delegateAccount, subjectHousehold, subjectAccount, status,
      categories, spendCapCents, noticeHours, earliestHour, latestHour, mayBook,
      mayReschedule, mayCancel, proposedAt, acceptedAt, acceptedVia, expiresAt,
      pairingCode, revokedAt, revokedBy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, categories=excluded.categories,
      spendCapCents=excluded.spendCapCents, noticeHours=excluded.noticeHours,
      earliestHour=excluded.earliestHour, latestHour=excluded.latestHour,
      mayBook=excluded.mayBook, mayReschedule=excluded.mayReschedule,
      mayCancel=excluded.mayCancel, acceptedAt=excluded.acceptedAt,
      acceptedVia=excluded.acceptedVia, expiresAt=excluded.expiresAt,
      pairingCode=excluded.pairingCode, revokedAt=excluded.revokedAt,
      revokedBy=excluded.revokedBy`,
  ).run(
    g.id,
    g.delegateAccount,
    g.subjectHousehold,
    g.subjectAccount,
    g.status,
    JSON.stringify(g.categories),
    g.spendCapCents,
    g.noticeHours,
    g.earliestHour,
    g.latestHour,
    g.mayBook ? 1 : 0,
    g.mayReschedule ? 1 : 0,
    g.mayCancel ? 1 : 0,
    g.proposedAt,
    g.acceptedAt,
    g.acceptedVia,
    g.expiresAt,
    g.pairingCode,
    g.revokedAt,
    g.revokedBy,
  );
}

export const getGrant = (db: Db, id_: string): Grant | null => {
  const r = row<GrantRow>(db, 'SELECT * FROM grant_row WHERE id = ?', id_);
  return r ? toGrant(r) : null;
};

/** The grant that lets `delegate` act in `household`, whatever state it is in. */
export const grantBetween = (db: Db, delegate: string, household: string): Grant | null => {
  const r = row<GrantRow>(
    db,
    `SELECT * FROM grant_row WHERE delegateAccount = ? AND subjectHousehold = ?
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'proposed' THEN 2
     ELSE 3 END, proposedAt DESC LIMIT 1`,
    delegate,
    household,
  );
  return r ? toGrant(r) : null;
};

/** Every grant row naming this delegate, whatever became of it. For history and for
 *  the arrangement pages, which have to show a revoked one to say that it ended. */
export const grantsForDelegate = (db: Db, delegate: string): Grant[] =>
  rows<GrantRow>(
    db,
    `SELECT * FROM grant_row WHERE delegateAccount = ? ORDER BY proposedAt DESC`,
    delegate,
  ).map(toGrant);

/**
 * The grants that actually let this delegate near another household's data.
 *
 * `grantsForDelegate` returns every row of any status, including `revoked`, `expired`
 * and `proposed`. Anything deciding what a caller may *reach* has to filter, and two
 * places were not: the household resolver every tool goes through, and the written
 * channel. A delegate whose arrangement had been revoked from the household's own
 * speaker — the control this product exists to sell — kept reading the diary, the audit
 * ledger and the other household's mail.
 *
 * `active` and `paused` both reach, because pausing is the household saying "not now"
 * rather than "never": the arrangement is still theirs and still visible on both sides,
 * and `authorize()` is what stops a paused delegate writing. `proposed` does not reach,
 * because nobody has agreed to it yet, and that is the whole point of proposing.
 *
 * An arrangement that has run out does not reach either, and that one was missed the
 * first time round. `status` is set by a person — accepting, pausing, revoking — and no
 * job flips it to `expired` when the clock passes `expiresAt`. So a grant a household
 * accepted for a year read as `active` forever. `authorize()` checks the date, one line
 * after it checks `revoked`, and nothing under `src/mcp/` called `authorize()`: with the
 * date moved past `expiresAt` the delegate still read the diary and the ledger. Status
 * and date are one question and this is the one place that answers it.
 */
export const liveGrantsForDelegate = (db: Db, delegate: string): Grant[] => {
  const now = nowIso();
  return grantsForDelegate(db, delegate).filter(
    (g) => (g.status === 'active' || g.status === 'paused') && g.expiresAt > now,
  );
};

export const grantsOverHousehold = (db: Db, household: string): Grant[] =>
  rows<GrantRow>(
    db,
    `SELECT * FROM grant_row WHERE subjectHousehold = ? ORDER BY proposedAt DESC`,
    household,
  ).map(toGrant);

export const grantByCode = (db: Db, code: string): Grant | null => {
  const r = row<GrantRow>(
    db,
    `SELECT * FROM grant_row WHERE pairingCode = ? AND status = 'proposed'`,
    code.toUpperCase(),
  );
  return r ? toGrant(r) : null;
};

export const getProvider = (db: Db, id_: string): Provider | null =>
  row<Provider>(db, 'SELECT * FROM provider WHERE id = ?', id_);

export const providersFor = (db: Db, category: string): Provider[] =>
  rows<Provider>(db, 'SELECT * FROM provider WHERE category = ? ORDER BY name', category);

export const allProviders = (db: Db): Provider[] =>
  rows<Provider>(db, 'SELECT * FROM provider ORDER BY category, name');

export function saveProvider(db: Db, p: Provider): void {
  db.prepare(
    `INSERT OR REPLACE INTO provider (id, name, category, phone, cancellationPolicy,
      cancellationFeeCents, freeCancelHours, ratePerVisitCents) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    p.id,
    p.name,
    p.category,
    p.phone,
    p.cancellationPolicy,
    p.cancellationFeeCents,
    p.freeCancelHours,
    p.ratePerVisitCents,
  );
}

export function saveVisit(db: Db, v: Visit): void {
  db.prepare(
    `INSERT INTO visit (id, householdId, providerId, category, summary, startsAt, endsAt,
      status, priceCents, reference, arrangedBy, arrangedAt, previousStartsAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET startsAt=excluded.startsAt, endsAt=excluded.endsAt,
      status=excluded.status, previousStartsAt=excluded.previousStartsAt,
      summary=excluded.summary, priceCents=excluded.priceCents`,
  ).run(
    v.id,
    v.householdId,
    v.providerId,
    v.category,
    v.summary,
    v.startsAt,
    v.endsAt,
    v.status,
    v.priceCents,
    v.reference,
    v.arrangedBy,
    v.arrangedAt,
    v.previousStartsAt,
  );
}

export const getVisit = (db: Db, id_: string): Visit | null =>
  row<Visit>(db, 'SELECT * FROM visit WHERE id = ?', id_);

export const upcomingVisits = (db: Db, householdId: string, fromIso: string): Visit[] =>
  rows<Visit>(
    db,
    `SELECT * FROM visit WHERE householdId = ? AND startsAt >= ?
     AND status IN ('booked','rescheduled','awaiting_subject') ORDER BY startsAt`,
    householdId,
    fromIso,
  );

/**
 * Anything already in the way, including a visit nobody has agreed to yet. Offering a
 * slot that a proposed visit is sitting on would produce two trades on one doorstep.
 */
export const occupiedSlots = (db: Db, householdId: string, fromIso: string): string[] =>
  rows<{ startsAt: string }>(
    db,
    `SELECT startsAt FROM visit WHERE householdId = ? AND startsAt >= ?
     AND status IN ('booked','rescheduled','awaiting_subject','proposed')`,
    householdId,
    fromIso,
  ).map((r) => r.startsAt);

export const visitsIn = (db: Db, householdId: string): Visit[] =>
  rows<Visit>(db, 'SELECT * FROM visit WHERE householdId = ? ORDER BY startsAt', householdId);

export function saveChange(db: Db, c: ChangeRequest): void {
  db.prepare(
    `INSERT INTO change_request (id, visitId, kind, requestedBy, requestedAt, status,
      offeredSlots, chosenSlot, holdReason, adjudication, decidedBy, decidedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, chosenSlot=excluded.chosenSlot,
      offeredSlots=excluded.offeredSlots, holdReason=excluded.holdReason,
      adjudication=excluded.adjudication, decidedBy=excluded.decidedBy,
      decidedAt=excluded.decidedAt`,
  ).run(
    c.id,
    c.visitId,
    c.kind,
    c.requestedBy,
    c.requestedAt,
    c.status,
    JSON.stringify(c.offeredSlots),
    c.chosenSlot,
    c.holdReason,
    c.adjudication ? JSON.stringify(c.adjudication) : null,
    c.decidedBy,
    c.decidedAt,
  );
}

type ChangeRow = Omit<ChangeRequest, 'offeredSlots' | 'adjudication'> & {
  offeredSlots: string;
  adjudication: string | null;
};

const toChange = (r: ChangeRow): ChangeRequest => ({
  ...r,
  offeredSlots: JSON.parse(r.offeredSlots) as string[],
  adjudication: r.adjudication ? JSON.parse(r.adjudication) : null,
});

export const getChange = (db: Db, id_: string): ChangeRequest | null => {
  const r = row<ChangeRow>(db, 'SELECT * FROM change_request WHERE id = ?', id_);
  return r ? toChange(r) : null;
};

export const openChangesForVisit = (db: Db, visitId: string): ChangeRequest[] =>
  rows<ChangeRow>(
    db,
    `SELECT * FROM change_request WHERE visitId = ? AND status IN ('offered','held_for_delegate')
     ORDER BY requestedAt DESC`,
    visitId,
  ).map(toChange);

export const changesForHousehold = (db: Db, householdId: string): ChangeRequest[] =>
  rows<ChangeRow>(
    db,
    `SELECT c.* FROM change_request c JOIN visit v ON v.id = c.visitId
     WHERE v.householdId = ? ORDER BY c.requestedAt DESC`,
    householdId,
  ).map(toChange);

export const heldChangesForHousehold = (db: Db, householdId: string): ChangeRequest[] =>
  changesForHousehold(db, householdId).filter((c) => c.status === 'held_for_delegate');

export function writeAudit(db: Db, e: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
  const entry: AuditEntry = { id: id('aud'), at: nowIso(), ...e };
  db.prepare(
    `INSERT INTO audit (id, at, householdId, actor, surface, action, subject, capability,
      reason, detail) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    entry.id,
    entry.at,
    entry.householdId,
    entry.actor,
    entry.surface,
    entry.action,
    entry.subject,
    entry.capability,
    entry.reason,
    JSON.stringify(entry.detail),
  );
  return entry;
}

type AuditRow = Omit<AuditEntry, 'detail'> & { detail: string };

export const auditFor = (db: Db, householdId: string, sinceIso?: string): AuditEntry[] =>
  rows<AuditRow>(
    db,
    `SELECT * FROM audit WHERE householdId = ? AND at >= ? ORDER BY at DESC`,
    householdId,
    sinceIso ?? '1970-01-01T00:00:00.000Z',
  ).map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));

export function saveOutbox(db: Db, m: OutboxMessage): void {
  db.prepare(
    `INSERT INTO outbox (id, at, channel, recipient, subject, body, status, attempts,
      lastError, relatedVisit, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, attempts=excluded.attempts,
      lastError=excluded.lastError`,
  ).run(
    m.id,
    m.at,
    m.channel,
    m.to,
    m.subject,
    m.body,
    m.status,
    m.attempts,
    m.lastError,
    m.relatedVisit,
    m.kind,
  );
}

type OutboxRow = Omit<OutboxMessage, 'to'> & { recipient: string };

export const outbox = (db: Db): OutboxMessage[] =>
  rows<OutboxRow>(db, 'SELECT * FROM outbox ORDER BY at DESC').map(({ recipient, ...r }) => ({
    ...r,
    to: recipient,
  }));

/**
 * The written channel as one person may see it: the messages addressed to them.
 *
 * `outbox()` is every message Standby has ever written, to either household, and the
 * console rendered it whole. The point of the written channel is that it is the only way
 * something reaches the other household, so showing one household the other's mail —
 * subject, body and address — undoes it. The table has no household column because a
 * message is addressed to a person, so the filter is by address, which is what an inbox
 * is.
 *
 * `deliver()` still works over the whole table: the delivery pass is the system acting,
 * not a person reading.
 */
export const outboxTo = (db: Db, addresses: readonly string[]): OutboxMessage[] => {
  const mine = new Set(addresses.filter(Boolean));
  return outbox(db).filter((m) => mine.has(m.to));
};

export const queuedOutbox = (db: Db): OutboxMessage[] =>
  outbox(db).filter((m) => m.status === 'queued');
