// The demo, run end to end over the real protocol.
//
// It starts the Streamable HTTP server, connects two MCP clients with two different
// bearer tokens, and drives the whole story through tool calls. Nothing here reaches
// into the database to make something true: if a step works, it worked over MCP.
//
//   npm run demo
//   STANDBY_NO_MODEL=1 npm run demo     (the same run with Bedrock switched off)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from './db.ts';
import { seed, MARIAN, NADIA, RIDGEWAY } from './seed.ts';
import { start } from './mcp/server.ts';
import { mintPair } from './mcp/auth.ts';
import { deliver } from './domain/outbox.ts';
import { outbox, getGrant } from './domain/store.ts';
import { draftTerms } from './bedrock/terms.ts';
import { adjudicate, gather } from './bedrock/adjudicate.ts';
import { gatherBrief, writeBrief } from './bedrock/brief.ts';
import { weeklyBrief } from './domain/messages.ts';
import { queue } from './domain/outbox.ts';
import { nowIso } from './clock.ts';
import { proposeGrant } from './domain/grants.ts';

const BAR = '='.repeat(78);
const out = (s = '') => process.stdout.write(`${s}\n`);

function scene(n: number, title: string, who: string) {
  out();
  out(BAR);
  out(`${n}. ${title}   [${who}]`);
  out(BAR);
}

interface Callable {
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  lastMs: number;
}

async function connect(port: number, bearer: string): Promise<Callable> {
  const client = new Client({ name: 'standby-demo', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  const c: Callable = {
    lastMs: 0,
    async call(name, args = {}) {
      const t = Date.now();
      const res = (await client.callTool({ name, arguments: args })) as {
        structuredContent?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
      };
      c.lastMs = Date.now() - t;
      return (res.structuredContent ?? {}) as Record<string, unknown>;
    },
    async close() {
      await client.close();
    },
  };
  return c;
}

function show(label: string, r: Record<string, unknown>, ms: number) {
  const facts = (r.facts ?? {}) as Record<string, unknown>;
  const rows = (r.rows ?? []) as Array<Record<string, unknown>>;
  const options = (r.options ?? []) as Array<Record<string, unknown>>;
  out(`  ${label}  ->  ${String(r.code)}  (${ms} ms round trip)`);
  for (const [k, v] of Object.entries(facts)) out(`      ${k}: ${v}`);
  rows.forEach((row, i) => {
    out(`      [${i + 1}] ${Object.entries(row).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  });
  options.forEach((o, i) => {
    out(`      option ${i + 1}: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  });
}

async function main(): Promise<void> {
  const db = openDb(':memory:');
  seed(db, { propose: false, withVisits: false });

  const port = 4190 + Math.floor(Math.random() * 300);
  const http = start(port, db);
  await new Promise((r) => http.once('listening', r));

  const marianToken = mintPair(db, MARIAN.id).access_token;
  const nadiaToken = mintPair(db, NADIA.id).access_token;
  const marian = await connect(port, marianToken);
  const nadia = await connect(port, nadiaToken);
  const times: number[] = [];
  const track = (c: Callable) => {
    times.push(c.lastMs);
    return c.lastMs;
  };

  out('ON BEHALF');
  out('One household running another household\'s admin, with both of them consenting.');
  out(`Ridgeway is Marian's home. Calder Street is Nadia's, two thousand miles away.`);

  // -------------------------------------------------------------------------
  scene(1, 'Nadia describes the arrangement in one sentence', 'Bedrock, off the voice path');
  const sentence =
    'I look after the boiler, the plumbing, the garden and the gutters at my mother\'s place, nothing over 200 dollars a visit, and never before 10 in the morning.';
  out(`  Typed: "${sentence}"`);
  const drafted = await draftTerms(sentence);
  out(
    `  ${drafted.fromFallback ? 'Model unreachable, so the keyword draft was used' : `Drafted by ${drafted.model}`}`,
  );
  out(`      covers: ${drafted.terms.categories.join(', ')}`);
  out(`      limit: ${(drafted.terms.spendCapCents / 100).toFixed(0)} dollars a visit`);
  out(`      hours: ${drafted.terms.earliestHour} to ${drafted.terms.latestHour}`);
  out(`      may cancel: ${drafted.terms.mayCancel}`);
  if (drafted.summary) out(`      summary: ${drafted.summary}`);
  for (const d of drafted.dropped) out(`      dropped: ${d}`);

  const proposal = proposeGrant(db, NADIA, RIDGEWAY, drafted.terms);
  out(`  Proposed. Nothing is granted yet. Pairing code: ${proposal.pairingCode}`);

  // -------------------------------------------------------------------------
  scene(2, 'Marian accepts, on her own Echo, on her own account', 'Marian, voice');
  show(
    'accept_arrangement',
    await marian.call('accept_arrangement', { code: proposal.pairingCode }),
    track(marian),
  );

  // -------------------------------------------------------------------------
  scene(3, 'Nadia finds a plumber and books one, from her own home', 'Nadia, voice');
  const found = await nadia.call('find_provider', { household: 'Ridgeway', category: 'plumbing' });
  show('find_provider', found, track(nadia));
  const first = ((found.rows ?? []) as Array<Record<string, unknown>>)[0]!;
  const booked = await nadia.call('book_visit', {
    household: 'Ridgeway',
    providerId: first.providerId,
    startsAt: first.nextStartsAt,
    summary: 'the dripping tap in the kitchen',
  });
  show('book_visit', booked, track(nadia));

  // -------------------------------------------------------------------------
  scene(4, '"Alexa, when is the plumber coming?"', 'Marian, voice');
  const visits = await marian.call('get_visits');
  show('get_visits', visits, track(marian));
  const visitRow = ((visits.rows ?? []) as Array<Record<string, unknown>>)[0]!;
  show(
    'who_arranged',
    await marian.call('who_arranged', { visitId: visitRow.visitId }),
    track(marian),
  );

  // -------------------------------------------------------------------------
  scene(5, '"I need to move it"', 'Marian, voice');
  const change = await marian.call('request_change', { phrase: `move the plumber` });
  show('request_change', change, track(marian));
  const opts = (change.options ?? []) as Array<Record<string, unknown>>;
  const changeIdForMove = (change.facts as Record<string, unknown>).changeId;
  out('  Only a time On Behalf itself offered can be confirmed. A mis-heard one is refused:');
  show(
    'confirm_change (a time nobody offered)',
    await marian.call('confirm_change', {
      changeId: changeIdForMove,
      startsAt: '2031-01-01T10:00:00.000Z',
    }),
    track(marian),
  );
  show(
    'confirm_change',
    await marian.call('confirm_change', {
      changeId: changeIdForMove,
      startsAt: opts[0]!.startsAt,
    }),
    track(marian),
  );

  // -------------------------------------------------------------------------
  scene(6, 'The written channel, because nothing can speak first', 'On Behalf backend');
  const report = deliver(db);
  out(`  ${report.sent} message(s) delivered by the mock transport, ${report.failed} retried.`);
  for (const m of outbox(db).slice(0, 3)) {
    out(`      ${m.channel} to ${m.to}: ${m.subject}`);
  }

  // -------------------------------------------------------------------------
  scene(7, '"What has Nadia changed at my house?"', 'Marian, voice');
  show('what_changed', await marian.call('what_changed', { days: 30 }), track(marian));

  // -------------------------------------------------------------------------
  scene(8, '"I need somebody to look at the gutters"', 'Marian, voice');
  const asked = await marian.call('ask_for_service', {
    category: 'gutters',
    note: 'the gutter over the back door is overflowing',
  });
  show('ask_for_service', asked, track(marian));

  // -------------------------------------------------------------------------
  scene(9, 'Bedrock argues the held request, off the voice path', 'Bedrock');
  const pending = await nadia.call('pending_decisions');
  show('pending_decisions', pending, track(nadia));
  const changeId = String(
    ((pending.rows ?? []) as Array<Record<string, unknown>>)[0]?.changeId ?? '',
  );
  if (changeId) {
    const input = gather(db, NADIA, changeId);
    if (input) {
      const adj = await adjudicate(db, input);
      out(
        `  ${adj.fromFallback ? 'Model unreachable, so the rules wrote this' : `Written by ${adj.model} in ${adj.latencyMs} ms, after the turn it relates to had already been answered`}`,
      );
      out(`      recommendation: ${adj.recommendation}`);
      out(`      ${adj.headline}`);
      for (const r of adj.reasons) out(`      reason: ${r}`);
      for (const r of adj.risks) out(`      risk: ${r}`);
    }
    // -----------------------------------------------------------------------
    scene(10, 'Nadia decides. The model advises; it never acts.', 'Nadia, touch');
    show(
      'decide_request',
      await nadia.call('decide_request', { changeId, verdict: 'approve' }),
      track(nadia),
    );
    out('  Above the limit Marian set, so agreeing is still hers to do.');

    // -----------------------------------------------------------------------
    scene(11, '"Alexa, what is waiting for me?"', 'Marian, voice');
    const waiting = await marian.call('what_is_waiting');
    show('what_is_waiting', waiting, track(marian));
    const waitingRow = ((waiting.rows ?? []) as Array<Record<string, unknown>>).find(
      (r) => r.kind === 'visit',
    );
    if (waitingRow) {
      show(
        'agree_to_visit',
        await marian.call('agree_to_visit', { visitId: waitingRow.visitId }),
        track(marian),
      );
    }
  }

  // -------------------------------------------------------------------------
  scene(12, 'Health is refused at the boundary, not in a policy document', 'Nadia, voice');
  const refused = await nadia.call('book_visit', {
    household: 'Ridgeway',
    providerId: 'prov_halloran',
    startsAt: nowIso(),
    summary: 'take her to the dentist appointment and pick up her prescription',
  });
  show('book_visit (health content)', refused, track(nadia));

  // -------------------------------------------------------------------------
  scene(13, 'Marian ends it from her own speaker, without asking anybody', 'Marian, voice');
  show('pause_arrangement', await marian.call('pause_arrangement'), track(marian));
  const afterPause = await nadia.call('find_provider', {
    household: 'Ridgeway',
    category: 'plumbing',
  });
  const pausedBook = await nadia.call('book_visit', {
    household: 'Ridgeway',
    providerId: ((afterPause.rows ?? []) as Array<Record<string, unknown>>)[0]?.providerId,
    startsAt: ((afterPause.rows ?? []) as Array<Record<string, unknown>>)[0]?.nextStartsAt,
    summary: 'a second look at the tap',
  });
  show('book_visit while paused', pausedBook, track(nadia));

  // -------------------------------------------------------------------------
  scene(14, 'The handover note, which is the only thing that can reach Nadia', 'Bedrock');
  const brief = await writeBrief(gatherBrief(db, NADIA, RIDGEWAY));
  db.prepare(
    `INSERT OR REPLACE INTO brief (householdId, delegateAccount, at, body, fromFallback, model)
     VALUES (?,?,?,?,?,?)`,
  ).run(RIDGEWAY.id, NADIA.id, nowIso(), brief.body, brief.fromFallback ? 1 : 0, brief.model);
  queue(
    db,
    weeklyBrief({ to: NADIA, house: RIDGEWAY, body: brief.body, fromFallback: brief.fromFallback }),
  );
  deliver(db);
  out(
    `  ${brief.fromFallback ? 'Model unreachable, so the ledger was listed plainly' : `Written by ${brief.model} in ${brief.latencyMs} ms`}`,
  );
  out();
  for (const line of brief.body.split('\n')) out(`      ${line}`);

  // -------------------------------------------------------------------------
  out();
  out(BAR);
  const sorted = [...times].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  out(
    `${times.length} voice turns over Streamable HTTP. median ${sorted[Math.floor(sorted.length / 2)]} ms, p95 ${p95} ms, worst ${sorted.at(-1)} ms. The MCP Toolkit budget is 500 ms.`,
  );
  out(`Grant left in state: ${getGrant(db, proposal.id)?.status}`);
  out(BAR);

  await marian.close();
  await nadia.close();
  http.close();
  db.close();
}

await main();
