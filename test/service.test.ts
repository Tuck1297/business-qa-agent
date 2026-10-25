import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DbAdapter } from '../src/tools/database/adapters/types.ts';
import { DatabaseService } from '../src/tools/database/service.ts';
import { exampleCatalog } from './helpers.ts';

const catalog = exampleCatalog();
const sales = catalog.sources[0]!;

function fakeAdapter(rows: Record<string, unknown>[]): DbAdapter & { calls: unknown[]; closed: boolean } {
  return {
    calls: [],
    closed: false,
    async query(sql, params, options) {
      this.calls.push({ sql, params, options });
      return rows;
    },
    async close() {
      this.closed = true;
    },
  };
}

describe('DatabaseService', () => {
  it('runs queries through one adapter per source, trims to the limit and flags truncation', async () => {
    const adapter = fakeAdapter([{ n: 1 }, { n: 2 }, { n: 3 }]);
    let created = 0;
    const db = new DatabaseService(catalog, {
      timeoutMs: 1234,
      env: { SALES_DATABASE_URL: 'postgres://x' },
      factory: async () => {
        created += 1;
        return adapter;
      },
    });
    const query = { sql: 'SELECT 1', params: [], columns: ['n'], rowLimit: 2 };
    const first = await db.run(sales, query);
    await db.run(sales, query);
    assert.equal(created, 1);
    assert.deepEqual(first.rows, [{ n: 1 }, { n: 2 }]);
    assert.equal(first.truncated, true);
    assert.deepEqual(adapter.calls[0], { sql: 'SELECT 1', params: [], options: { timeoutMs: 1234 } });
    await db.close();
    assert.equal(adapter.closed, true);
  });

  it('makes driver values JSON-friendly', async () => {
    const db = new DatabaseService(catalog, {
      timeoutMs: 1000,
      env: { SALES_DATABASE_URL: 'x' },
      factory: async () => fakeAdapter([{ big: 9007199254740993n, when: new Date('2026-10-01T00:00:00Z'), blob: new Uint8Array(4) }]),
    });
    const { rows } = await db.run(sales, { sql: '', params: [], columns: [], rowLimit: 10 });
    assert.deepEqual(rows[0], { big: '9007199254740993', when: '2026-10-01T00:00:00.000Z', blob: '<4 bytes>' });
  });

  it('explains a missing connection variable and retries a failed connection next time', async () => {
    const missing = new DatabaseService(catalog, { timeoutMs: 1000, env: {}, factory: async () => fakeAdapter([]) });
    await assert.rejects(missing.run(sales, { sql: '', params: [], columns: [], rowLimit: 1 }), /SALES_DATABASE_URL/);

    let attempts = 0;
    const flaky = new DatabaseService(catalog, {
      timeoutMs: 1000,
      env: { SALES_DATABASE_URL: 'x' },
      factory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('connection refused');
        return fakeAdapter([{ ok: true }]);
      },
    });
    await assert.rejects(flaky.run(sales, { sql: '', params: [], columns: [], rowLimit: 5 }), /connection refused/);
    await new Promise((r) => setImmediate(r));
    const retried = await flaky.run(sales, { sql: '', params: [], columns: [], rowLimit: 5 });
    assert.deepEqual(retried.rows, [{ ok: true }]);
  });
});
