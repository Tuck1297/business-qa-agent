/** Owns the catalog and one connection pool per source, created on first use. */

import type { Catalog, CatalogSource } from './catalog.ts';
import type { CompiledQuery } from './compile.ts';
import { createPostgresAdapter } from './adapters/postgres.ts';
import { createSqlServerAdapter } from './adapters/sqlserver.ts';
import type { DbAdapter } from './adapters/types.ts';

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** True when the table had more rows than the plan's limit. */
  truncated: boolean;
}

export type AdapterFactory = (source: CatalogSource, connectionString: string, timeoutMs: number) => Promise<DbAdapter>;

export const defaultAdapterFactory: AdapterFactory = (source, connectionString, timeoutMs) =>
  source.engine === 'postgres'
    ? createPostgresAdapter(connectionString)
    : createSqlServerAdapter(connectionString, timeoutMs);

export class DatabaseService {
  readonly catalog: Catalog;
  private readonly adapters = new Map<string, Promise<DbAdapter>>();
  private readonly env: Record<string, string | undefined>;
  private readonly factory: AdapterFactory;
  private readonly timeoutMs: number;

  constructor(
    catalog: Catalog,
    options: { timeoutMs: number; env?: Record<string, string | undefined>; factory?: AdapterFactory },
  ) {
    this.catalog = catalog;
    this.timeoutMs = options.timeoutMs;
    this.env = options.env ?? process.env;
    this.factory = options.factory ?? defaultAdapterFactory;
  }

  async run(source: CatalogSource, query: CompiledQuery): Promise<QueryResult> {
    const adapter = await this.adapter(source);
    const rows = await adapter.query(query.sql, query.params, { timeoutMs: this.timeoutMs });
    const truncated = rows.length > query.rowLimit;
    return {
      columns: query.columns,
      rows: (truncated ? rows.slice(0, query.rowLimit) : rows).map(normalizeRow),
      truncated,
    };
  }

  async close(): Promise<void> {
    const adapters = [...this.adapters.values()];
    this.adapters.clear();
    await Promise.allSettled(adapters.map(async (a) => (await a).close()));
  }

  private adapter(source: CatalogSource): Promise<DbAdapter> {
    let adapter = this.adapters.get(source.name);
    if (!adapter) {
      const connectionString = this.env[source.connectionEnv];
      if (!connectionString) {
        return Promise.reject(new Error(`Environment variable ${source.connectionEnv} (connection for source "${source.name}") isn't set.`));
      }
      adapter = this.factory(source, connectionString, this.timeoutMs);
      // Forget a failed connection so the next question retries it.
      adapter.catch(() => this.adapters.delete(source.name));
      this.adapters.set(source.name, adapter);
    }
    return adapter;
  }
}

/** Make driver values JSON-friendly (bigint, Date, Buffer). */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') out[key] = value.toString();
    else if (value instanceof Date) out[key] = Number.isNaN(value.getTime()) ? null : value.toISOString();
    else if (value instanceof Uint8Array) out[key] = `<${value.byteLength} bytes>`;
    else out[key] = value;
  }
  return out;
}
