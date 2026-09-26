// Storage. node:sqlite, so the whole app has no database dependency at all.
//
// Every read a voice tool performs goes through a prepared statement against a local
// file. That is deliberate: the MCP Toolkit requires a round trip under 500 ms, so
// nothing on the read path is allowed to cross a network.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS household (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL, areaLabel TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY, linkedSubject TEXT NOT NULL UNIQUE, displayName TEXT NOT NULL,
  householdId TEXT NOT NULL, email TEXT NOT NULL, sms TEXT
);
CREATE TABLE IF NOT EXISTS grant_row (
  id TEXT PRIMARY KEY, delegateAccount TEXT NOT NULL, subjectHousehold TEXT NOT NULL,
  subjectAccount TEXT NOT NULL, status TEXT NOT NULL, categories TEXT NOT NULL,
  spendCapCents INTEGER NOT NULL, noticeHours INTEGER NOT NULL,
  earliestHour INTEGER NOT NULL, latestHour INTEGER NOT NULL,
  mayBook INTEGER NOT NULL, mayReschedule INTEGER NOT NULL, mayCancel INTEGER NOT NULL,
  proposedAt TEXT NOT NULL, acceptedAt TEXT, acceptedVia TEXT, expiresAt TEXT NOT NULL,
  pairingCode TEXT, revokedAt TEXT, revokedBy TEXT
);
CREATE TABLE IF NOT EXISTS provider (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, phone TEXT NOT NULL,
  cancellationPolicy TEXT NOT NULL, cancellationFeeCents INTEGER NOT NULL,
  freeCancelHours INTEGER NOT NULL, ratePerVisitCents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS visit (
  id TEXT PRIMARY KEY, householdId TEXT NOT NULL, providerId TEXT NOT NULL,
  category TEXT NOT NULL, summary TEXT NOT NULL, startsAt TEXT NOT NULL,
  endsAt TEXT NOT NULL, status TEXT NOT NULL, priceCents INTEGER NOT NULL,
  reference TEXT NOT NULL, arrangedBy TEXT NOT NULL, arrangedAt TEXT NOT NULL,
  previousStartsAt TEXT
);
CREATE INDEX IF NOT EXISTS visit_house_time ON visit (householdId, startsAt);
CREATE TABLE IF NOT EXISTS change_request (
  id TEXT PRIMARY KEY, visitId TEXT NOT NULL, kind TEXT NOT NULL,
  requestedBy TEXT NOT NULL, requestedAt TEXT NOT NULL, status TEXT NOT NULL,
  offeredSlots TEXT NOT NULL, chosenSlot TEXT, holdReason TEXT, adjudication TEXT,
  decidedBy TEXT, decidedAt TEXT
);
CREATE INDEX IF NOT EXISTS change_visit ON change_request (visitId);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, householdId TEXT NOT NULL, actor TEXT NOT NULL,
  surface TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, capability TEXT,
  reason TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_house_time ON audit (householdId, at);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, channel TEXT NOT NULL, recipient TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL, lastError TEXT, relatedVisit TEXT, kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_code (
  code TEXT PRIMARY KEY, accountId TEXT NOT NULL, challenge TEXT NOT NULL,
  method TEXT NOT NULL, issuedAt TEXT NOT NULL, redeemedAt TEXT
);
CREATE TABLE IF NOT EXISTS oauth_token (
  token TEXT PRIMARY KEY, accountId TEXT NOT NULL, kind TEXT NOT NULL,
  issuedAt TEXT NOT NULL, expiresAt TEXT NOT NULL, revokedAt TEXT
);
CREATE TABLE IF NOT EXISTS brief (
  householdId TEXT NOT NULL, delegateAccount TEXT NOT NULL, at TEXT NOT NULL,
  body TEXT NOT NULL, fromFallback INTEGER NOT NULL, model TEXT,
  PRIMARY KEY (householdId, delegateAccount)
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function defaultDbPath(): string {
  return process.env.STANDBY_DB ?? new URL('../data/standby.db', import.meta.url).pathname;
}

/** Rows come back as null-prototype objects; this makes them ordinary. */
export function rows<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db
    .prepare(sql)
    .all(...(params as never[]))
    .map((r) => ({ ...(r as object) })) as T[];
}

export function row<T>(db: Db, sql: string, ...params: unknown[]): T | null {
  const r = db.prepare(sql).get(...(params as never[]));
  return r ? ({ ...(r as object) } as T) : null;
}
