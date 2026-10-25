import type { BoundParam } from '../sql.ts';

export interface QueryOptions {
  timeoutMs: number;
}

export interface DbAdapter {
  /** Run one of your tool's statements with bound parameters ($1… for Postgres, @p_name for SQL Server). */
  query(sql: string, params: BoundParam[], options: QueryOptions): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}
