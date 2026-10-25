/**
 * Postgres (and Postgres-compatible, e.g. CockroachDB) adapter using `pg`.
 *
 * Every query runs inside `BEGIN READ ONLY` with a per-query statement_timeout and is
 * rolled back afterwards. Still connect with a database user that only has SELECT on
 * the views your tools use: the read-only transaction is a second lock, not the first.
 */

import type { BoundParam } from '../sql.ts';
import type { DbAdapter, QueryOptions } from './types.ts';

// The parts of `pg` this adapter uses. Declared locally so the core doesn't depend on @types/pg.
interface PgPoolClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(error?: Error | boolean): void;
}
interface PgPool {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
interface PgModule {
  Pool: new (config: { connectionString: string; max?: number; application_name?: string }) => PgPool;
  types?: { setTypeParser(oid: number, parser: (value: string) => unknown): void };
}

/** Postgres DATE type id. */
const DATE_OID = 1082;

export async function createPostgresAdapter(connectionString: string): Promise<DbAdapter> {
  let mod: PgModule;
  try {
    const imported = (await import('pg')) as unknown as { default?: PgModule } & PgModule;
    mod = imported.default ?? imported;
  } catch (error) {
    throw new Error(`The "pg" package isn't installed. Run npm install. (${String(error)})`);
  }
  // Return DATE columns as "YYYY-MM-DD" text. By default pg turns them into JS Dates at the
  // server's local midnight, which can shift the day once converted to UTC.
  mod.types?.setTypeParser(DATE_OID, (value) => value);
  const pool = new mod.Pool({ connectionString, max: 4, application_name: 'business-qa-agent' });
  // An idle client error must not crash the process.
  pool.on('error', (error) => console.error('[postgres] idle client error:', error.message));

  return {
    async query(sql: string, params: BoundParam[], options: QueryOptions) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN READ ONLY');
        // SET LOCAL can't take a bind parameter; the value is a validated integer.
        await client.query(`SET LOCAL statement_timeout = ${Math.trunc(options.timeoutMs)}`);
        const result = await client.query(sql, params.map((p) => p.value));
        return result.rows;
      } catch (error) {
        broken = isConnectionError(error);
        throw error;
      } finally {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
        client.release(broken);
      }
    },
    async close() {
      await pool.end();
    },
  };
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('08') || code === 'ECONNRESET' || code === 'EPIPE');
}
