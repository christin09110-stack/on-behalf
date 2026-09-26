// The Alexa+ MCP Toolkit requires OAuth 2.1, authorization code grant, PKCE with
// S256, and refresh tokens, and states that PKCE is checked at deploy. These are the
// four ways that check can fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { caught, world, MARIAN, NADIA } from './helpers.ts';
import {
  AuthError,
  callerFromHeader,
  issueCode,
  redeemCode,
  refresh,
  s256,
} from '../src/mcp/auth.ts';

const verifier = () => randomBytes(48).toString('base64url');

test('the plain PKCE method is refused', () => {
  const db = world();
  const v = verifier();
  const err = caught<AuthError>(() => issueCode(db, MARIAN.id, s256(v), 'plain'));
  assert.equal(err.code, 'invalid_request');
  assert.equal(err.status, 400);
  assert.match(err.message, /S256/);
});

test('a malformed challenge is refused before a code is ever issued', () => {
  const db = world();
  const err = caught<AuthError>(() => issueCode(db, MARIAN.id, 'short', 'S256'));
  assert.equal(err.code, 'invalid_request');
});

test('the happy path issues an access token and a refresh token', () => {
  const db = world();
  const v = verifier();
  const code = issueCode(db, MARIAN.id, s256(v), 'S256');
  const pair = redeemCode(db, code, v);
  assert.equal(pair.token_type, 'Bearer');
  assert.ok(pair.access_token.length > 20);
  assert.ok(pair.refresh_token.length > 20);
  assert.equal(pair.expires_in, 3600);
});

test('a verifier that does not match the challenge is refused', () => {
  const db = world();
  const code = issueCode(db, MARIAN.id, s256(verifier()), 'S256');
  const err = caught<AuthError>(() => redeemCode(db, code, verifier()));
  assert.equal(err.code, 'invalid_grant');
  assert.match(err.message, /does not match/);
});

test('a code can only be redeemed once', () => {
  const db = world();
  const v = verifier();
  const code = issueCode(db, MARIAN.id, s256(v), 'S256');
  redeemCode(db, code, v);
  const err = caught<AuthError>(() => redeemCode(db, code, v));
  assert.equal(err.code, 'invalid_grant');
  assert.match(err.message, /already been used/);
});

test('refreshing rotates the refresh token, so a stolen one dies on first use', () => {
  const db = world();
  const v = verifier();
  const pair = redeemCode(db, issueCode(db, MARIAN.id, s256(v), 'S256'), v);
  const next = refresh(db, pair.refresh_token);
  assert.notEqual(next.refresh_token, pair.refresh_token);
  const err = caught<AuthError>(() => refresh(db, pair.refresh_token));
  assert.equal(err.code, 'invalid_grant');
});

test('a token resolves to exactly one account and one household', () => {
  const db = world();
  const v = verifier();
  const pair = redeemCode(db, issueCode(db, NADIA.id, s256(v), 'S256'), v);
  const caller = callerFromHeader(db, `Bearer ${pair.access_token}`, 'voice');
  assert.equal(caller.account.id, NADIA.id);
  assert.equal(caller.household.id, NADIA.householdId);
});

test('a missing or unknown token is a 401, not a silent empty answer', () => {
  const db = world();
  for (const header of [undefined, '', 'Bearer nonsense', 'Basic abc']) {
    const err = caught<AuthError>(() => callerFromHeader(db, header, 'voice'));
    assert.equal(err.status, 401, `header ${String(header)}`);
  }
});

test('a revoked token stops working immediately', () => {
  const db = world();
  const v = verifier();
  const pair = redeemCode(db, issueCode(db, MARIAN.id, s256(v), 'S256'), v);
  db.prepare('UPDATE oauth_token SET revokedAt = ? WHERE token = ?').run(
    new Date().toISOString(),
    pair.access_token,
  );
  const err = caught<AuthError>(() =>
    callerFromHeader(db, `Bearer ${pair.access_token}`, 'voice'),
  );
  assert.equal(err.status, 401);
});
