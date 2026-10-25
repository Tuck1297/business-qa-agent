/**
 * SQL Server / Azure SQL adapter using `mssql`.
 *
 * The compiler only ever emits a single SELECT, so the query itself can't write.
 * Connect with a login that is only in db_datareader (or has SELECT on the catalog's
 * views) so the database enforces read-only too.
 */

import type { FilterValue } from '../spec.ts';
import type { DbAdapter, QueryOptions } from './types.ts';

// The parts of `mssql` this adapter uses, declared locally.
interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  query(sql: string): Promise<{ recordset?: Record<string, unknown>[] }>;
}
interface MssqlPool {
  connect(): Promise<MssqlPool>;
  request(): MssqlRequest;
  close(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
interface MssqlModule {
  ConnectionPool: {
    new (config: string | Record<string, unknown>): MssqlPool;
    parseConnectionString?: (connectionString: string) => Record<string, unknown>;
  };
}

export async function createSqlServerAdapter(connectionString: string, requestTimeoutMs: number): Promise<DbAdapter> {
  let mod: MssqlModule;
  try {
    const imported = (await import('mssql')) as unknown as { default?: MssqlModule } & MssqlModule;
    mod = imported.default ?? imported;
  } catch (error) {
    throw new Error(`The "mssql" package isn't installed. Run npm install. (${String(error)})`);
  }

  // Parse the connection string when the library can, so the request timeout applies.
  // Otherwise fall back to the raw string (add "Request Timeout=..." to it yourself).
  const parse = mod.ConnectionPool.parseConnectionString;
  const config: string | Record<string, unknown> = parse
    ? { ...parse(connectionString), requestTimeout: requestTimeoutMs }
    : connectionString;

  const pool = new mod.ConnectionPool(config);
  pool.on('error', (error) => console.error('[sqlserver] pool error:', error.message));
  const ready = pool.connect();
  // Don't crash on an early connection failure; the error surfaces on the first query instead.
  ready.catch(() => undefined);

  return {
    async query(sql: string, params: FilterValue[], _options: QueryOptions) {
      await ready;
      const request = pool.request();
      params.forEach((value, i) => request.input(`p${i + 1}`, value));
      const result = await request.query(sql);
      return result.recordset ?? [];
    },
    async close() {
      await ready.catch(() => undefined);
      await pool.close();
    },
  };
}
