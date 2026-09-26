import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db.ts';
import { seed } from '../src/seed.ts';

process.env.STANDBY_OUTBOX_DIR ??= mkdtempSync(join(tmpdir(), 'standby-test-'));

export function world(opts: Parameters<typeof seed>[1] = {}): Db {
  const db = openDb(':memory:');
  seed(db, opts);
  return db;
}

export { MARIAN, NADIA, RIDGEWAY, CALDER, PROVIDERS } from '../src/seed.ts';

/** node:assert's `throws` does not hand the error back, and these tests inspect it. */
export function caught<T extends Error>(fn: () => unknown): T {
  try {
    fn();
  } catch (e) {
    return e as T;
  }
  throw new Error('expected a throw, got none');
}
