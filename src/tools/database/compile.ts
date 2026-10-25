/**
 * Turn a validated QuerySpec into one parameterized SELECT for Postgres or SQL Server.
 *
 * Safety comes from structure, not from inspecting SQL text:
 * - identifiers come only from the catalog and are always quoted;
 * - every value is a bound parameter;
 * - the only statement produced is a single SELECT with a row cap;
 * - metric SQL is written by the catalog owner, never by the model.
 */

import type { CatalogColumn, CatalogTable, Engine } from './catalog.ts';
import type { FilterValue, QuerySpec, SelectItem, TimeGrain } from './spec.ts';

export interface CompiledQuery {
  sql: string;
  params: FilterValue[];
  /** Output column names, in select order. */
  columns: string[];
  /** Rows requested by the plan (after the MAX_ROWS cap). The SQL asks for one more to detect truncation. */
  rowLimit: number;
}

interface Dialect {
  quote(identifier: string): string;
  param(index: number): string;
  timeGrain(expr: string, grain: TimeGrain): string;
  sum(expr: string, column: CatalogColumn): string;
  avg(expr: string, column: CatalogColumn): string;
  like(expr: string, param: string): string;
  escapeLike(value: string): string;
  limit(sql: { select: string; rest: string }, limit: number): string;
}

const postgres: Dialect = {
  quote: (id) => `"${id.replace(/"/g, '""')}"`,
  param: (i) => `$${i}`,
  timeGrain: (expr, grain) => (grain === 'day' ? `(${expr})::date` : `date_trunc('${grain}', ${expr})::date`),
  sum: (expr) => `SUM(${expr})`,
  avg: (expr) => `AVG(${expr})`,
  like: (expr, param) => `${expr} ILIKE ${param} ESCAPE '\\'`,
  escapeLike: (value) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`),
  limit: ({ select, rest }, limit) => `SELECT ${select}${rest}\nLIMIT ${limit}`,
};

const sqlserver: Dialect = {
  quote: (id) => `[${id.replace(/]/g, ']]')}]`,
  param: (i) => `@p${i}`,
  timeGrain: (expr, grain) => {
    switch (grain) {
      case 'day':
        return `CAST(${expr} AS date)`;
      case 'week': // Monday-start weeks, the same as Postgres date_trunc('week'), whatever @@DATEFIRST is.
        return `DATEADD(day, -((DATEPART(weekday, ${expr}) + @@DATEFIRST + 5) % 7), CAST(${expr} AS date))`;
      case 'month':
        return `DATEFROMPARTS(YEAR(${expr}), MONTH(${expr}), 1)`;
      case 'quarter':
        return `DATEFROMPARTS(YEAR(${expr}), (DATEPART(quarter, ${expr}) - 1) * 3 + 1, 1)`;
      case 'year':
        return `DATEFROMPARTS(YEAR(${expr}), 1, 1)`;
    }
  },
  // SQL Server sums int columns as int (overflow risk) and averages them as int (truncation).
  sum: (expr, column) => (column.type === 'integer' ? `SUM(CAST(${expr} AS bigint))` : `SUM(${expr})`),
  avg: (expr, column) => (column.type === 'integer' ? `AVG(CAST(${expr} AS float))` : `AVG(${expr})`),
  like: (expr, param) => `${expr} LIKE ${param} ESCAPE '\\'`,
  escapeLike: (value) => value.replace(/[\\%_[]/g, (ch) => `\\${ch}`),
  limit: ({ select, rest }, limit) => `SELECT TOP (${limit}) ${select}${rest}`,
};

const DIALECTS: Record<Engine, Dialect> = { postgres, sqlserver };

export function compileQuery(
  spec: QuerySpec,
  table: CatalogTable,
  engine: Engine,
  maxRows: number,
): CompiledQuery {
  const d = DIALECTS[engine];
  const columns = new Map(table.columns.map((c) => [c.name, c]));
  const metrics = new Map((table.metrics ?? []).map((m) => [m.name, m]));
  const params: FilterValue[] = [];
  const addParam = (value: FilterValue) => {
    params.push(value);
    return d.param(params.length);
  };
  const col = (name: string) => {
    const column = columns.get(name);
    if (!column) throw new Error(`Unknown column "${name}" (spec wasn't validated).`);
    return column;
  };

  const hasAggregate = spec.select.some((s) => s.kind !== 'column');
  const aliases = uniqueAliases(spec.select);
  const selectParts: string[] = [];
  const groupBy: string[] = [];

  spec.select.forEach((item, i) => {
    const alias = aliases[i] ?? `col_${i}`;
    let expr: string;
    if (item.kind === 'column') {
      const column = col(item.column ?? '');
      expr = d.quote(column.name);
      if (item.timeGrain) expr = d.timeGrain(expr, item.timeGrain);
      if (hasAggregate) groupBy.push(expr);
    } else if (item.kind === 'aggregate') {
      expr = aggregateExpr(d, item, item.column === null ? null : col(item.column));
    } else {
      const metric = metrics.get(item.metric ?? '');
      if (!metric) throw new Error(`Unknown metric "${item.metric}" (spec wasn't validated).`);
      expr = `(${metric.sql})`;
    }
    selectParts.push(`${expr} AS ${d.quote(alias)}`);
  });

  const where = spec.filters.map((f) => {
    const expr = d.quote(col(f.column).name);
    const v = f.values;
    switch (f.operator) {
      case 'eq':
        return `${expr} = ${addParam(v[0]!)}`;
      case 'neq':
        return `${expr} <> ${addParam(v[0]!)}`;
      case 'gt':
        return `${expr} > ${addParam(v[0]!)}`;
      case 'gte':
        return `${expr} >= ${addParam(v[0]!)}`;
      case 'lt':
        return `${expr} < ${addParam(v[0]!)}`;
      case 'lte':
        return `${expr} <= ${addParam(v[0]!)}`;
      case 'between':
        return `${expr} BETWEEN ${addParam(v[0]!)} AND ${addParam(v[1]!)}`;
      case 'in':
        return `${expr} IN (${v.map(addParam).join(', ')})`;
      case 'not_in':
        return `${expr} NOT IN (${v.map(addParam).join(', ')})`;
      case 'contains':
        return d.like(expr, addParam(`%${d.escapeLike(String(v[0]))}%`));
      case 'starts_with':
        return d.like(expr, addParam(`${d.escapeLike(String(v[0]))}%`));
      case 'is_null':
        return `${expr} IS NULL`;
      case 'is_not_null':
        return `${expr} IS NOT NULL`;
    }
  });

  let orderBy = spec.orderBy.map((o) => `${d.quote(aliases[o.selectIndex] ?? '')} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`);
  if (orderBy.length === 0) {
    // Time series read best oldest-first; otherwise leave the database's order.
    orderBy = spec.select.flatMap((s, i) => (s.kind === 'column' && s.timeGrain ? [`${d.quote(aliases[i] ?? '')} ASC`] : []));
  }

  const from = table.schema ? `${d.quote(table.schema)}.${d.quote(table.name)}` : d.quote(table.name);
  const rowLimit = Math.min(spec.limit ?? maxRows, maxRows);
  let rest = `\nFROM ${from}`;
  if (where.length) rest += `\nWHERE ${where.join('\n  AND ')}`;
  if (groupBy.length) rest += `\nGROUP BY ${groupBy.join(', ')}`;
  if (orderBy.length) rest += `\nORDER BY ${orderBy.join(', ')}`;

  return {
    sql: d.limit({ select: selectParts.join(',\n       '), rest }, rowLimit + 1),
    params,
    columns: aliases,
    rowLimit,
  };
}

function aggregateExpr(d: Dialect, item: SelectItem, column: CatalogColumn | null): string {
  if (column === null) return 'COUNT(*)';
  const expr = d.quote(column.name);
  switch (item.aggregate) {
    case 'count':
      return `COUNT(${expr})`;
    case 'count_distinct':
      return `COUNT(DISTINCT ${expr})`;
    case 'sum':
      return d.sum(expr, column);
    case 'avg':
      return d.avg(expr, column);
    case 'min':
      return `MIN(${expr})`;
    case 'max':
      return `MAX(${expr})`;
    default:
      throw new Error('Aggregate item without an aggregate (spec wasn\'t validated).');
  }
}

/** Deterministic, readable output names; the model never names columns. */
export function uniqueAliases(select: SelectItem[]): string[] {
  const used = new Map<string, number>();
  return select.map((item) => {
    let base: string;
    if (item.kind === 'metric') base = item.metric ?? 'metric';
    else if (item.kind === 'aggregate') base = item.column === null ? 'count_all' : `${item.aggregate}_${item.column}`;
    else base = item.timeGrain ? `${item.column}_${item.timeGrain}` : (item.column ?? 'column');
    base = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'col';
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}
