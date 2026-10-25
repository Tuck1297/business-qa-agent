/** Runs your tools: binds arguments, caps rows, one connection pool per source (created on first use). */

import type { DbTool, ToolSet, ToolSource } from './definitions.ts';
import { normalizeSql, sourceOf } from './definitions.ts';
import { createPostgresAdapter } from './adapters/postgres.ts';
import { createSqlServerAdapter } from './adapters/sqlserver.ts';
import type { DbAdapter } from './adapters/types.ts';
import type { ArgValue } from './arguments.ts';
import { bindSql, capRows } from './sql.ts';

export interface QueryResult {
  rows: Record<string, unknown>[];
  /** True when the SQL returned more rows than the cap. */
  truncated: boolean;
  rowLimit: number;
}

export type AdapterFactory = (source: ToolSource, connectionString: string, timeoutMs: number) => Promise<DbAdapter>;

export const defaultAdapterFactory: AdapterFactory = (source, connectionString, timeoutMs) =>
  source.engine === 'postgres' ? createPostgresAdapter(connectionString) : createSqlServerAdapter(connectionString, timeoutMs);

export class DatabaseService {
  readonly tools: ToolSet;
  private readonly adapters = new Map<string, Promise<DbAdapter>>();
  private readonly env: Record<string, string | undefined>;
  private readonly factory: AdapterFactory;
  private readonly timeoutMs: number;
  private readonly maxRows: number;

  constructor(
    tools: ToolSet,
    options: { timeoutMs: number; maxRows: number; env?: Record<string, string | undefined>; factory?: AdapterFactory },
  ) {
    this.tools = tools;
    this.timeoutMs = options.timeoutMs;
    this.maxRows = options.maxRows;
    this.env = options.env ?? process.env;
    this.factory = options.factory ?? defaultAdapterFactory;
  }

  /** The exact statement and parameters a call would run (for step events and debugging). */
  prepare(tool: DbTool, args: Record<string, ArgValue>): { sql: string; params: Array<{ name: string; value: ArgValue }>; rowLimit: number } {
    const source = sourceOf(this.tools, tool);
    const types = Object.fromEntries(tool.parameters.map((p) => [p.name, p.type]));
    const bound = bindSql(normalizeSql(tool.sql), source.engine, types, args);
    const rowLimit = Math.min(tool.maxRows ?? this.maxRows, this.maxRows);
    return {
      sql: capRows(bound.text, source.engine, rowLimit),
      params: bound.params.map((p) => ({ name: p.name, value: p.value })),
      rowLimit,
    };
  }

  async run(tool: DbTool, args: Record<string, ArgValue>): Promise<QueryResult> {
    const source = sourceOf(this.tools, tool);
    const types = Object.fromEntries(tool.parameters.map((p) => [p.name, p.type]));
    const bound = bindSql(normalizeSql(tool.sql), source.engine, types, args);
    const rowLimit = Math.min(tool.maxRows ?? this.maxRows, this.maxRows);
    const adapter = await this.adapter(source);
    const rows = await adapter.query(capRows(bound.text, source.engine, rowLimit), bound.params, { timeoutMs: this.timeoutMs });
    const truncated = rows.length > rowLimit;
    return { rows: (truncated ? rows.slice(0, rowLimit) : rows).map(normalizeRow), truncated, rowLimit };
  }

  async close(): Promise<void> {
    const adapters = [...this.adapters.values()];
    this.adapters.clear();
    await Promise.allSettled(adapters.map(async (a) => (await a).close()));
  }

  private adapter(source: ToolSource): Promise<DbAdapter> {
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
