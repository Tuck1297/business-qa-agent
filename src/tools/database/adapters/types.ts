import type { FilterValue } from '../spec.ts';

export interface QueryOptions {
  timeoutMs: number;
}

export interface DbAdapter {
  /** Run one read-only SELECT with bound parameters ($1… for Postgres, @p1… for SQL Server). */
  query(sql: string, params: FilterValue[], options: QueryOptions): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}
