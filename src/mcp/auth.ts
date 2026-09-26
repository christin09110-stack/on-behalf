// Account linking.
//
// The Alexa+ MCP Toolkit requires OAuth 2.1 with the authorization code grant, PKCE
// with S256, and refresh tokens, and it checks PKCE at deploy time. It gives the
// add-on one linked account per customer and no notion of who is speaking.
//
// Standby implements that grant here rather than faking a session, because the whole
// product rests on knowing which household a turn arrived from. `plain` PKCE is
// rejected, a verifier that does not match is rejected, and a code cannot be redeemed
// twice. Those three are the tests.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.ts';
import { getAccount, getHousehold } from '../domain/store.ts';
import type { Account, CallerContext, Household, Surface } from '../types.ts';
import { token } from '../ids.ts';
import { addHours, nowIso } from '../clock.ts';
import { row } from '../db.ts';

export class AuthError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

const ACCESS_TOKEN_HOURS = 1;
const REFRESH_TOKEN_HOURS = 24 * 90;

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Step one: the customer has signed in and approved. Hand back a single-use code. */
export function issueCode(
  db: Db,
  accountId: string,
  challenge: string,
  method: string,
): string {
  if (method !== 'S256') {
    throw new AuthError(
      'invalid_request',
      400,
      'On Behalf only accepts PKCE with S256. The plain method is not allowed.',
    );
  }
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(challenge)) {
    throw new AuthError('invalid_request', 400, 'That is not a valid S256 code challenge.');
  }
  const code = token();
  db.prepare(
    `INSERT INTO oauth_code (code, accountId, challenge, method, issuedAt, redeemedAt)
     VALUES (?,?,?,?,?,NULL)`,
  ).run(code, accountId, challenge, method, nowIso());
  return code;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

/** Step two: swap the code for tokens, proving the verifier. Single use, enforced. */
export function redeemCode(db: Db, code: string, verifier: string): TokenPair {
  const rec = row<{ accountId: string; challenge: string; redeemedAt: string | null }>(
    db,
    'SELECT accountId, challenge, redeemedAt FROM oauth_code WHERE code = ?',
    code,
  );
  if (!rec) throw new AuthError('invalid_grant', 400, 'On Behalf does not know that code.');
  if (rec.redeemedAt) {
    throw new AuthError('invalid_grant', 400, 'That code has already been used once.');
  }
  if (!verifier || !sameString(s256(verifier), rec.challenge)) {
    throw new AuthError('invalid_grant', 400, 'The code verifier does not match the challenge.');
  }
  db.prepare('UPDATE oauth_code SET redeemedAt = ? WHERE code = ?').run(nowIso(), code);
  return mintPair(db, rec.accountId);
}

export function mintPair(db: Db, accountId: string): TokenPair {
  const access = token();
  const refresh = token();
  const stmt = db.prepare(
    `INSERT INTO oauth_token (token, accountId, kind, issuedAt, expiresAt, revokedAt)
     VALUES (?,?,?,?,?,NULL)`,
  );
  stmt.run(access, accountId, 'access', nowIso(), addHours(nowIso(), ACCESS_TOKEN_HOURS));
  stmt.run(refresh, accountId, 'refresh', nowIso(), addHours(nowIso(), REFRESH_TOKEN_HOURS));
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_HOURS * 3600,
  };
}

export function refresh(db: Db, refreshToken: string): TokenPair {
  const rec = row<{ accountId: string; expiresAt: string; revokedAt: string | null }>(
    db,
    `SELECT accountId, expiresAt, revokedAt FROM oauth_token WHERE token = ? AND kind = 'refresh'`,
    refreshToken,
  );
  if (!rec || rec.revokedAt || rec.expiresAt <= nowIso()) {
    throw new AuthError('invalid_grant', 400, 'That refresh token is not usable.');
  }
  db.prepare('UPDATE oauth_token SET revokedAt = ? WHERE token = ?').run(nowIso(), refreshToken);
  return mintPair(db, rec.accountId);
}

export interface Caller extends CallerContext {
  account: Account;
  household: Household;
}

/** Resolve an Authorization header to the one account the turn belongs to. */
export function callerFromHeader(
  db: Db,
  header: string | undefined,
  surface: Surface,
): Caller {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) {
    throw new AuthError('unauthorized', 401, 'This add-on needs a linked account.');
  }
  const rec = row<{ accountId: string; expiresAt: string; revokedAt: string | null }>(
    db,
    `SELECT accountId, expiresAt, revokedAt FROM oauth_token WHERE token = ? AND kind = 'access'`,
    match[1]!.trim(),
  );
  if (!rec || rec.revokedAt || rec.expiresAt <= nowIso()) {
    throw new AuthError('unauthorized', 401, 'That link has expired. Link the account again.');
  }
  const account = getAccount(db, rec.accountId);
  if (!account) throw new AuthError('unauthorized', 401, 'That account is no longer linked.');
  const household = getHousehold(db, account.householdId);
  if (!household) throw new AuthError('unauthorized', 401, 'That account has no household.');
  return { account, household, surface };
}
