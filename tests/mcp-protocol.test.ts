// The protocol itself, exercised with a real MCP client over Streamable HTTP.
//
// The Alexa+ MCP Toolkit track requires spec revision 2025-11-25 or later, so the
// negotiated revision is asserted rather than assumed: a dependency bump that drops it
// fails here instead of failing at certification.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { world, MARIAN, NADIA, CALDER } from './helpers.ts';
import { start, PROTOCOL_VERSION } from '../src/mcp/server.ts';
import { mintPair } from '../src/mcp/auth.ts';
import { ALL_TOOLS } from '../src/mcp/tools.ts';
import type { Db } from '../src/db.ts';

let db: Db;
let http: ReturnType<typeof start>;
let port: number;
const clients = new Map<string, Client>();

async function connect(account: string, bearer?: string) {
  const client = new Client({ name: 'standby-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer ?? mintPair(db, account).access_token}` } },
    }),
  );
  return client;
}

before(async () => {
  db = world();
  port = 4900 + Math.floor(Math.random() * 200);
  http = start(port, db);
  await new Promise((r) => http.once('listening', r));
  clients.set(MARIAN.id, await connect(MARIAN.id));
  clients.set(NADIA.id, await connect(NADIA.id));
});

after(async () => {
  for (const c of clients.values()) await c.close();
  http.close();
  db.close();
});

const call = (account: string, name: string, args: Record<string, unknown> = {}) =>
  clients.get(account)!.callTool({ name, arguments: args }) as Promise<{
    structuredContent?: { ok?: boolean; code?: string; facts?: Record<string, unknown>; rows?: unknown[] };
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;

test('the negotiated protocol revision is the one this track requires', () => {
  assert.equal(PROTOCOL_VERSION, '2025-11-25');
  const negotiated = clients.get(MARIAN.id)!.getServerVersion();
  assert.equal(negotiated?.name, 'standby');
});

test('every registered tool is advertised, with a description and a schema', async () => {
  const listed = await clients.get(MARIAN.id)!.listTools();
  assert.equal(listed.tools.length, ALL_TOOLS.length);
  for (const t of listed.tools) {
    assert.ok((t.description ?? '').length > 30, `${t.name} has a thin description`);
    assert.ok(t.inputSchema, `${t.name} has no input schema`);
  }
});

test('read-only tools are annotated as read-only', async () => {
  const listed = await clients.get(MARIAN.id)!.listTools();
  const byName = new Map(listed.tools.map((t) => [t.name, t]));
  assert.equal(byName.get('get_visits')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('confirm_cancellation')?.annotations?.readOnlyHint, false);
});

test('a tool call returns both a text rendering and structured content', async () => {
  const r = await call(MARIAN.id, 'get_visits');
  assert.equal(r.structuredContent?.code, 'visits');
  assert.ok((r.content ?? []).some((c) => c.type === 'text' && (c.text ?? '').length > 0));
});

test('an unlinked caller is refused, and the refusal is readable', async () => {
  const client = new Client({ name: 'standby-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );
  const r = (await client.callTool({ name: 'get_visits', arguments: {} })) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  assert.equal(r.isError, true);
  assert.match(r.content?.[0]?.text ?? '', /linked account/);
  await client.close();
});

test('two accounts on the same server see two different households', async () => {
  const marian = await call(MARIAN.id, 'get_visits');
  const nadia = await call(NADIA.id, 'get_visits');
  assert.equal(marian.structuredContent?.facts?.household, 'Ridgeway');
  assert.equal(nadia.structuredContent?.facts?.household, 'Calder Street');
});

test('the delegate can read the other household by name, in the words they would use', async () => {
  for (const hint of ['Ridgeway', 'ridgeway', 'ridge']) {
    const r = await call(NADIA.id, 'get_visits', { household: hint });
    assert.equal(r.structuredContent?.facts?.household, 'Ridgeway', hint);
  }
});

test('the household cannot read a home nobody gave them a say over', async () => {
  // This test used to assert the opposite, with a comment saying resolution finds the
  // home and the capability engine refuses to act on it. The capability engine is on the
  // write paths; the read tools called `targetHousehold` and returned whatever it gave
  // them. So the read succeeded and a security review found the care diary of a
  // household nobody had granted anything over. Resolution now happens inside the
  // reachable set, so the read is refused where it always should have been.
  const read = await call(MARIAN.id, 'get_visits', { household: 'Calder Street' });
  assert.equal(read.isError, true, 'reading an unreachable home must be refused');
  assert.match(read.content?.[0]?.text ?? '', /you can act in/);

  const write = await call(MARIAN.id, 'request_change', {
    household: 'Calder Street',
    phrase: 'move the cleaner',
  });
  assert.equal(write.isError, true);
});

test('a raw household id is no more powerful than the name', async () => {
  // `targetHousehold` used to try `getHousehold(db, hint)` before working out what the
  // caller could reach, so knowing an id was enough. Every id is printed somewhere.
  const r = await call(MARIAN.id, 'get_visits', { household: CALDER.id });
  assert.equal(r.isError, true, 'a household id must not bypass the reachable set');
});

test('a loose name match cannot wander outside the reachable set', async () => {
  // The old last resort was a substring search over every household in the database.
  // 'a' appears in both home names, so it used to be a way to be handed a stranger's.
  const r = await call(MARIAN.id, 'get_visits', { household: 'a' });
  assert.equal(r.structuredContent?.facts?.household, 'Ridgeway', 'matched her own home, or refused');
});

test('a refusal comes back as an error result rather than a protocol failure', async () => {
  const r = await call(NADIA.id, 'book_visit', {
    household: 'Ridgeway',
    providerId: 'prov_halloran',
    startsAt: new Date().toISOString(),
    summary: 'pick up her prescription from the pharmacy',
  });
  assert.equal(r.isError, true);
  assert.match(r.content?.[0]?.text ?? '', /health/);
});

test('the health endpoint reports the protocol and the tool count', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const json = (await res.json()) as { protocol: string; tools: number };
  assert.equal(json.protocol, '2025-11-25');
  assert.equal(json.tools, ALL_TOOLS.length);
});
