// The 500 ms round trip is a platform requirement, so it is a test rather than a
// README claim. This runs the same harness `npm run bench` does, with fewer samples.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBench, BUDGET_MS } from '../src/bench/latency.ts';

test(
  'every voice tool answers well inside the round-trip budget',
  { timeout: 120_000 },
  async () => {
    const rows = await runBench(30);
    assert.ok(rows.length >= 8, 'the harness did not measure enough tools');
    for (const r of rows) {
      assert.ok(
        r.p95 < BUDGET_MS,
        `${r.tool} p95 was ${r.p95.toFixed(1)} ms, over the ${BUDGET_MS} ms budget`,
      );
      assert.ok(r.max < BUDGET_MS * 2, `${r.tool} worst case was ${r.max.toFixed(1)} ms`);
    }
    const worst = Math.max(...rows.map((r) => r.p95));
    assert.ok(
      worst < BUDGET_MS / 5,
      `the worst p95 was ${worst.toFixed(1)} ms, which leaves too little headroom for a real network`,
    );
  },
);
