// The structural test.
//
// "Your MCP server must meet a round-trip query response latency of less than 500 ms."
// A model call cannot promise that, so the rule in this codebase is that nothing under
// `src/bedrock/` may be reachable from the MCP tool registry. A comment saying so would
// last until the first hurried afternoon, so this walks the import graph instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, '../src/mcp/server.ts');

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of src.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) queue.push(resolve(dirname(file), spec));
  }
  return seen;
}

test('no Bedrock module is reachable from the MCP server', () => {
  const files = [...reachable(ENTRY)];
  const offenders = files.filter((f) => f.includes(`${'/'}src${'/'}bedrock${'/'}`));
  assert.deepEqual(
    offenders,
    [],
    `these are on the voice path and must not be:\n${offenders.join('\n')}`,
  );
});

test('no AWS SDK import is reachable from the MCP server', () => {
  for (const file of reachable(ENTRY)) {
    const src = readFileSync(file, 'utf8');
    assert.ok(
      !/@aws-sdk\//.test(src),
      `${file} pulls in the AWS SDK, which puts a network call on the voice path`,
    );
  }
});

test('the graph walk actually walks, rather than passing on an empty set', () => {
  const files = reachable(ENTRY);
  assert.ok(files.size > 12, `only found ${files.size} files, so the walk is broken`);
  assert.ok([...files].some((f) => f.endsWith('capability.ts')));
  assert.ok([...files].some((f) => f.endsWith('visits.ts')));
});

test('the Bedrock modules do exist, so the test above is not vacuous', () => {
  for (const f of ['adjudicate.ts', 'brief.ts', 'terms.ts', 'client.ts']) {
    assert.ok(existsSync(resolve(here, '../src/bedrock', f)), f);
  }
});
