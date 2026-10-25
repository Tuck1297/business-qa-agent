/**
 * :named parameters in your SQL → driver placeholders.
 *
 *   Postgres:   :start_date → ($1::date)   (the cast lets Postgres type NULLs and reused params)
 *   SQL Server: :start_date → @p_start_date
 *
 * The scanner skips strings, quoted identifiers, comments and Postgres "::" casts,
 * so `'10:30'`, `"col:name"` and `x::date` are left alone.
 */

import type { Engine, ParamType } from './definitions.ts';

export interface NamedParam {
  name: string;
  start: number;
  end: number;
}

export interface BoundParam {
  /** Placeholder name as the driver sees it: "1" for $1, or "p_start_date" for @p_start_date. */
  name: string;
  value: string | number | boolean | null;
  type: ParamType;
}

export interface BoundSql {
  text: string;
  params: BoundParam[];
}

const PG_CAST: Record<ParamType, string> = {
  string: 'text',
  number: 'numeric',
  integer: 'bigint',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
};

export function findNamedParams(sql: string, engine: Engine): NamedParam[] {
  const found: NamedParam[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    // Comments
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    // Strings and quoted identifiers ('' / "" / ]] escape by doubling)
    if (ch === "'" || ch === '"' || (ch === '[' && engine === 'sqlserver')) {
      const close = ch === '[' ? ']' : ch;
      i++;
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) i += 2;
          else break;
        } else i++;
      }
      i++;
      continue;
    }
    // Postgres cast "::type"
    if (ch === ':' && next === ':') {
      i += 2;
      continue;
    }
    if (ch === ':' && next !== undefined && /[a-z_]/.test(next)) {
      let j = i + 1;
      while (j < n && /[a-z0-9_]/.test(sql[j]!)) j++;
      found.push({ name: sql.slice(i + 1, j), start: i, end: j });
      i = j;
      continue;
    }
    i++;
  }
  return found;
}

export function bindSql(
  sql: string,
  engine: Engine,
  types: Record<string, ParamType>,
  values: Record<string, string | number | boolean | null>,
): BoundSql {
  const matches = findNamedParams(sql, engine);
  const params: BoundParam[] = [];
  const indexByName = new Map<string, number>();
  let text = '';
  let last = 0;

  for (const m of matches) {
    const type = types[m.name];
    if (!type) throw new Error(`The SQL uses :${m.name}, which isn't a declared parameter.`);
    if (!(m.name in values)) throw new Error(`No value for parameter :${m.name}.`);
    const value = values[m.name] ?? null;
    text += sql.slice(last, m.start);
    if (engine === 'postgres') {
      let index = indexByName.get(m.name);
      if (index === undefined) {
        params.push({ name: String(params.length + 1), value, type });
        index = params.length;
        indexByName.set(m.name, index);
      }
      text += `($${index}::${PG_CAST[type]})`;
    } else {
      const name = `p_${m.name}`;
      if (!indexByName.has(m.name)) {
        indexByName.set(m.name, params.length);
        params.push({ name, value, type });
      }
      text += `@${name}`;
    }
    last = m.end;
  }
  text += sql.slice(last);
  return { text, params };
}

/**
 * Cap the rows a statement can return (one extra, to detect truncation).
 * Postgres wraps the statement; SQL Server uses SET ROWCOUNT, which also works with
 * a top-level ORDER BY and WITH that a subquery wrapper would break.
 */
export function capRows(sql: string, engine: Engine, limit: number): string {
  const n = Math.trunc(limit) + 1;
  if (engine === 'postgres') return `SELECT * FROM (\n${sql}\n) AS capped_result\nLIMIT ${n}`;
  return `SET ROWCOUNT ${n};\n${sql};\nSET ROWCOUNT 0;`;
}
