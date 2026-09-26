// The round-trip measurement, because the platform states a number.
//
// "Choose the Proper Alexa+ Integration Approach" says: "Your MCP server must meet a
// round-trip query response latency of less than 500 ms." That is a requirement, not
// advice, so it gets measured rather than asserted.
//
// What is measured is the whole thing: an MCP client on a real Streamable HTTP
// connection, through the transport, through auth, through the tool, and back with
// parsed structured content. The server builds a fresh McpServer per request, so this
// is the cold number.
//
//   npm run bench
//   npm run bench -- 400          (more iterations)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../db.ts';
import { seed, MARIAN, NADIA } from '../seed.ts';
import { start } from '../mcp/server.ts';
import { mintPair } from '../mcp/auth.ts';

export const BUDGET_MS = 500;

export interface BenchRow {
  tool: string;
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export async function runBench(iterations = 120): Promise<BenchRow[]> {
  const db = openDb(':memory:');
  seed(db);
  const port = 4600 + Math.floor(Math.random() * 300);
  const http = start(port, db);
  await new Promise((r) => http.once('listening', r));

  const calls: Array<[string, string, Record<string, unknown>]> = [
    ['get_visits', MARIAN.id, {}],
    ['what_is_waiting', MARIAN.id, {}],
    ['what_changed', MARIAN.id, { days: 30 }],
    ['request_change', MARIAN.id, { phrase: 'move the plumber' }],
    ['on_behalf_status', MARIAN.id, {}],
    ['list_on_behalf_households', NADIA.id, {}],
    ['find_provider', NADIA.id, { household: 'Ridgeway', category: 'plumbing' }],
    ['pending_decisions', NADIA.id, {}],
  ];

  const tokens = new Map<string, string>();
  const clients = new Map<string, Client>();
  for (const account of [MARIAN.id, NADIA.id]) {
    const t = mintPair(db, account).access_token;
    tokens.set(account, t);
    const client = new Client({ name: 'standby-bench', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${t}` } },
      }),
    );
    clients.set(account, client);
  }

  const results: BenchRow[] = [];
  for (const [tool, account, args] of calls) {
    const client = clients.get(account)!;
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t = process.hrtime.bigint();
      await client.callTool({ name: tool, arguments: args });
      samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    samples.sort((a, b) => a - b);
    results.push({
      tool,
      n: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
      max: samples.at(-1)!,
    });
  }

  for (const c of clients.values()) await c.close();
  http.close();
  db.close();
  return results;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const n = Number(process.argv[2] ?? 120);
  const rows = await runBench(n);
  const pad = (s: string, w: number) => s.padEnd(w);
  process.stdout.write(
    `\nRound trip through MCP Streamable HTTP, ${n} calls each, budget ${BUDGET_MS} ms\n\n`,
  );
  process.stdout.write(
    `${pad('tool', 26)}${pad('p50', 9)}${pad('p95', 9)}${pad('p99', 9)}${pad('max', 9)}\n`,
  );
  let worst = 0;
  for (const r of rows) {
    worst = Math.max(worst, r.p95);
    process.stdout.write(
      `${pad(r.tool, 26)}${pad(r.p50.toFixed(1), 9)}${pad(r.p95.toFixed(1), 9)}${pad(r.p99.toFixed(1), 9)}${pad(r.max.toFixed(1), 9)}\n`,
    );
  }
  process.stdout.write(
    `\nworst p95 across all tools: ${worst.toFixed(1)} ms, which is ${((worst / BUDGET_MS) * 100).toFixed(1)} percent of the budget\n`,
  );
  process.exit(worst < BUDGET_MS ? 0 : 1);
}
