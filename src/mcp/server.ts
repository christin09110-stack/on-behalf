// The MCP server, on Streamable HTTP.
//
// Stateless: a fresh server and transport per request, because the account the turn
// belongs to arrives in the Authorization header and nothing should outlive it. That
// also means the latency figure in the README is a cold figure, not a warmed one.
//
// Everything a handler touches is a prepared statement against a local file. No model,
// no network, no remote catalogue. That is what keeps the round trip inside the 500 ms
// the MCP Toolkit asks for, and `npm run bench` prints the number.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { openDb, defaultDbPath, type Db } from '../db.ts';
import { ALL_TOOLS } from './tools.ts';
import { invokeTool } from './registry.ts';
import { AuthError, callerFromHeader } from './auth.ts';
import { StandbyError } from '../domain/grants.ts';
import { ScreenError } from '../domain/screening.ts';
import { ReadbackError } from '../domain/readback.ts';

export const PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

/** Turn a result into the two things MCP carries: a data object and a text rendering. */
function toContent(result: ReturnType<(typeof ALL_TOOLS)[number]['run']>) {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(result.facts ?? {})) lines.push(`${k}: ${v}`);
  (result.rows ?? []).forEach((r, i) => {
    lines.push(`--- ${i + 1}`);
    for (const [k, v] of Object.entries(r)) lines.push(`${k}: ${v}`);
  });
  (result.options ?? []).forEach((o, i) => {
    lines.push(`option ${i + 1}`);
    for (const [k, v] of Object.entries(o)) lines.push(`${k}: ${v}`);
  });
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') || result.code }],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: false,
  };
}

function failure(message: string, code: string) {
  return {
    content: [{ type: 'text' as const, text: `refused: ${message}` }],
    structuredContent: { ok: false, code, facts: { refusal: message } },
    isError: true,
  };
}

export function buildServer(db: Db, authHeader: string | undefined): McpServer {
  const server = new McpServer(
    { name: 'standby', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'On Behalf lets one household run another household\'s trade, delivery and repair admin, ' +
        'with both households linked on their own accounts. It covers no health arrangements of ' +
        'any kind. Read booking details back before booking, and read the cancellation policy ' +
        'back before cancelling.',
    },
  );

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          readOnlyHint: !tool.writes,
          destructiveHint: tool.name.startsWith('confirm_cancellation') || tool.name === 'end_arrangement',
          openWorldHint: false,
        },
      },
      (args: Record<string, unknown>) => {
        try {
          const caller = callerFromHeader(db, authHeader, 'voice');
          return toContent(invokeTool(db, caller, tool, args ?? {}));
        } catch (e) {
          if (e instanceof AuthError) return failure(e.message, e.code);
          if (e instanceof StandbyError) return failure(e.message, e.code);
          if (e instanceof ScreenError) return failure(e.message, e.code);
          if (e instanceof ReadbackError) return failure(e.message, e.code);
          throw e;
        }
      },
    );
  }
  return server;
}

async function handle(db: Db, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, tools: ALL_TOOLS.length }));
    return;
  }
  const server = buildServer(db, req.headers.authorization);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function start(port = Number(process.env.PORT ?? 4180), db: Db = openDb(defaultDbPath())) {
  const http = createServer((req, res) => {
    handle(db, req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'failed' }));
    });
  });
  http.listen(port, () => {
    process.stdout.write(
      `On Behalf MCP on http://localhost:${port}/mcp, protocol ${PROTOCOL_VERSION}, ${ALL_TOOLS.length} tools\n`,
    );
  });
  return http;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  start();
}
