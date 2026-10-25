/**
 * SQL Server / Azure SQL adapter using `mssql`.
 *
 * Tool SQL is checked to be a single SELECT when tools.json loads. Connect with a login
 * that is only in db_datareader (or has SELECT on the views your tools use) so the
 * database enforces read-only too.
 */

import type { ParamType } from '../definitions.ts';
import type { BoundParam } from '../sql.ts';
import { toText } from '../../../text.ts';
import type { DbAdapter, QueryOptions } from './types.ts';

// The parts of `mssql` this adapter uses, declared locally.
interface MssqlRequest {
  input(name: string, typeOrValue: unknown, value?: unknown): MssqlRequest;
  query(sql: string): Promise<{ recordset?: Record<string, unknown>[] }>;
}
interface MssqlPool {
  connect(): Promise<MssqlPool>;
  request(): MssqlRequest;
  close(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
type MssqlTypeFactory = ((...args: number[]) => unknown) | undefined;
interface MssqlModule {
  NVarChar?: MssqlTypeFactory;
  Float?: unknown;
  BigInt?: unknown;
  Bit?: unknown;
  Date?: unknown;
  DateTimeOffset?: unknown;
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
    throw new Error(`The "mssql" package isn't installed. Run npm install. (${toText(error)})`, { cause: error });
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
    async query(sql: string, params: BoundParam[], _options: QueryOptions) {
      await ready;
      const request = pool.request();
      for (const p of params) {
        const type = sqlType(mod, p.type);
        const value = toDriverValue(p.value, p.type);
        if (type === undefined) request.input(p.name, value);
        else request.input(p.name, type, value);
      }
      const result = await request.query(sql);
      return result.recordset ?? [];
    },
    async close() {
      await ready.catch(() => undefined);
      await pool.close();
    },
  };
}

/** Declare parameter types explicitly so NULLs and dates bind correctly. */
function sqlType(mod: MssqlModule, type: ParamType): unknown {
  switch (type) {
    case 'string':
      return typeof mod.NVarChar === 'function' ? mod.NVarChar(4000) : undefined;
    case 'number':
      return mod.Float;
    case 'integer':
      return mod.BigInt;
    case 'boolean':
      return mod.Bit;
    case 'date':
      return mod.Date;
    case 'datetime':
      return mod.DateTimeOffset;
  }
}

function toDriverValue(value: BoundParam['value'], type: ParamType): unknown {
  if (value === null) return null;
  // Date types bind from JS Dates; "YYYY-MM-DD" parses as UTC midnight, matching mssql's default useUTC.
  if ((type === 'date' || type === 'datetime') && typeof value === 'string') return new Date(value);
  return value;
}
