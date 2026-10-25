import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DbAdapter } from '../src/tools/database/adapters/types.ts';
import { findTool } from '../src/tools/database/definitions.ts';
import { DatabaseService } from '../src/tools/database/service.ts';
import { exampleTools } from './helpers.ts';

const set = exampleTools();
const top = findTool(set, 'top_unpaid_customers')!;
const tickets = findTool(set, 'open_tickets_by_priority')!;
const overdue = findTool(set, 'overdue_invoices')!;

function fakeAdapter(
  rows: Record<string, unknown>[],
): DbAdapter & { calls: Array<{ sql: string; params: unknown[] }>; closed: boolean } {
  return {
    calls: [],
    closed: false,
    async query(sql, params) {
      this.calls.push({ sql, params });
      return rows;
    },
    async close() {
      this.closed = true;
    },
  };
}

describe('DatabaseService', () => {
  it('runs your SQL with bound, typed parameters and a row cap, one adapter per source', async () => {
    const adapter = fakeAdapter([{ customer_name: 'A', balance: '1', open_invoices: '1' }]);
    let created = 0;
    const db = new DatabaseService(set, {
      timeoutMs: 1000,
      maxRows: 200,
      env: { SALES_DATABASE_URL: 'postgres://x' },
      factory: async () => {
        created += 1;
        return adapter;
      },
    });
    await db.run(top, { limit: 3, region: null });
    await db.run(overdue, { as_of: '2026-10-25', region: 'North' });
    assert.equal(created, 1);
    const first = adapter.calls[0]!;
    assert.match(first.sql, /^SELECT \* FROM \(\nSELECT customer_name,/);
    assert.match(first.sql, /LIMIT \(\$2::bigint\)\n\) AS capped_result\nLIMIT 201$/);
    assert.deepEqual(first.params, [
      { name: '1', value: null, type: 'string' },
      { name: '2', value: 3, type: 'integer' },
    ]);
    // overdue_invoices has its own maxRows of 100.
    assert.match(adapter.calls[1]!.sql, /LIMIT 101$/);
    await db.close();
    assert.equal(adapter.closed, true);
  });

  it('trims to the cap and flags truncation', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ priority: `p${i}`, open_tickets: i }));
    const db = new DatabaseService(set, {
      timeoutMs: 1000,
      maxRows: 3,
      env: { SUPPORT_DATABASE_URL: 'x' },
      factory: async () => fakeAdapter(rows),
    });
    const result = await db.run(tickets, {});
    assert.equal(result.rows.length, 3);
    assert.equal(result.truncated, true);
    assert.equal(result.rowLimit, 3);
    assert.match(db.prepare(tickets, {}).sql, /^SET ROWCOUNT 4;/);
  });

  it('makes driver values JSON-friendly', async () => {
    const db = new DatabaseService(set, {
      timeoutMs: 1000,
      maxRows: 10,
      env: { SUPPORT_DATABASE_URL: 'x' },
      factory: async () =>
        fakeAdapter([{ big: 9007199254740993n, when: new Date('2026-10-01T00:00:00Z'), blob: new Uint8Array(4) }]),
    });
    const { rows } = await db.run(tickets, {});
    assert.deepEqual(rows[0], { big: '9007199254740993', when: '2026-10-01T00:00:00.000Z', blob: '<4 bytes>' });
  });

  it('explains a missing connection variable and retries a failed connection next time', async () => {
    const missing = new DatabaseService(set, {
      timeoutMs: 1000,
      maxRows: 10,
      env: {},
      factory: async () => fakeAdapter([]),
    });
    await assert.rejects(missing.run(tickets, {}), /SUPPORT_DATABASE_URL/);

    let attempts = 0;
    const flaky = new DatabaseService(set, {
      timeoutMs: 1000,
      maxRows: 10,
      env: { SUPPORT_DATABASE_URL: 'x' },
      factory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('connection refused');
        return fakeAdapter([{ priority: 'urgent', open_tickets: 2 }]);
      },
    });
    await assert.rejects(flaky.run(tickets, {}), /connection refused/);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual((await flaky.run(tickets, {})).rows, [{ priority: 'urgent', open_tickets: 2 }]);
  });
});
