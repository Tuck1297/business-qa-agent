/**
 * The query spec: what the model is allowed to ask the database for.
 *
 * The model never writes SQL. It fills in this structure (enforced by a strict JSON
 * Schema whose enums list only the chosen table's columns and metrics), we validate
 * it against the catalog, and the compiler turns it into parameterized SQL.
 */

import type { CatalogColumn, CatalogTable, ColumnType } from './catalog.ts';

export const AGGREGATES = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;
export const TIME_GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export const OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'contains',
  'starts_with',
  'between',
  'is_null',
  'is_not_null',
] as const;

export type Aggregate = (typeof AGGREGATES)[number];
export type TimeGrain = (typeof TIME_GRAINS)[number];
export type Operator = (typeof OPERATORS)[number];
export type FilterValue = string | number | boolean;

export interface SelectItem {
  kind: 'column' | 'aggregate' | 'metric';
  column: string | null;
  aggregate: Aggregate | null;
  metric: string | null;
  timeGrain: TimeGrain | null;
}

export interface Filter {
  column: string;
  operator: Operator;
  values: FilterValue[];
}

export interface OrderBy {
  /** Zero-based index into `select`. */
  selectIndex: number;
  direction: 'asc' | 'desc';
}

export interface QuerySpec {
  /** One sentence, plain language: what this query returns. Shown to the user. */
  explanation: string;
  select: SelectItem[];
  filters: Filter[];
  orderBy: OrderBy[];
  limit: number | null;
}

export const LIMITS = { select: 25, filters: 20, orderBy: 5, values: 100 } as const;

const NUMERIC: readonly ColumnType[] = ['number', 'integer'];
const TEMPORAL: readonly ColumnType[] = ['date', 'datetime'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Strict-mode JSON Schema for one table: column and metric names are enums, so the model can't invent them. */
export function buildSpecSchema(table: CatalogTable, maxRows: number): Record<string, unknown> {
  const columnNames = table.columns.map((c) => c.name);
  const metricNames = (table.metrics ?? []).map((m) => m.name);

  const nullableEnum = (values: readonly string[]) =>
    values.length > 0 ? { type: ['string', 'null'], enum: [...values, null] } : { type: 'null' };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['explanation', 'select', 'filters', 'orderBy', 'limit'],
    properties: {
      explanation: {
        type: 'string',
        description: 'One short sentence in plain language describing what the query returns.',
      },
      select: {
        type: 'array',
        description: `Output columns, 1 to ${LIMITS.select}. Plain columns are grouped automatically when any aggregate or metric is selected.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'column', 'aggregate', 'metric', 'timeGrain'],
          properties: {
            kind: { type: 'string', enum: ['column', 'aggregate', 'metric'] },
            column: {
              ...nullableEnum(columnNames),
              description: 'Column for kind "column" or "aggregate". Null for kind "metric", and for count of all rows.',
            },
            aggregate: {
              ...nullableEnum(AGGREGATES),
              description: 'Required for kind "aggregate", otherwise null. sum and avg need a numeric column.',
            },
            metric: {
              ...nullableEnum(metricNames),
              description: 'A predefined metric for kind "metric", otherwise null. Prefer a metric over rebuilding it from columns.',
            },
            timeGrain: {
              ...nullableEnum(TIME_GRAINS),
              description: 'Only for kind "column" on a date or datetime column: bucket the date (e.g. month). Otherwise null.',
            },
          },
        },
      },
      filters: {
        type: 'array',
        description: `Row filters, all combined with AND. 0 to ${LIMITS.filters}.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['column', 'operator', 'values'],
          properties: {
            column: { type: 'string', enum: columnNames },
            operator: { type: 'string', enum: [...OPERATORS] },
            values: {
              type: 'array',
              description:
                'eq/neq/gt/gte/lt/lte/contains/starts_with: exactly 1 value. between: exactly 2 (low, high, inclusive). in/not_in: 1 or more. is_null/is_not_null: none. Dates as YYYY-MM-DD.',
              items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
          },
        },
      },
      orderBy: {
        type: 'array',
        description: `Sort order, 0 to ${LIMITS.orderBy} entries, referring to select items by zero-based index.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['selectIndex', 'direction'],
          properties: {
            selectIndex: { type: 'integer' },
            direction: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
      },
      limit: {
        type: ['integer', 'null'],
        description: `Maximum rows to return, 1 to ${maxRows}; null for the default (${maxRows}). Use a small limit for "top N" questions.`,
      },
    },
  };
}

export class SpecError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The query plan isn't valid:\n- ${problems.join('\n- ')}`);
    this.name = 'SpecError';
    this.problems = problems;
  }
}

/**
 * Validate a model-produced spec against the table, coerce values to the column types,
 * and return a clean copy. Throws SpecError listing every problem (fed back to the model on retry).
 */
export function validateSpec(raw: unknown, table: CatalogTable, maxRows: number): QuerySpec {
  const problems: string[] = [];
  if (!isObject(raw)) throw new SpecError(['The plan must be a JSON object.']);

  const columns = new Map(table.columns.map((c) => [c.name, c]));
  const metrics = new Map((table.metrics ?? []).map((m) => [m.name, m]));

  const explanation = typeof raw.explanation === 'string' ? raw.explanation.trim().slice(0, 300) : '';
  const rawSelect = Array.isArray(raw.select) ? raw.select : [];
  const rawFilters = Array.isArray(raw.filters) ? raw.filters : [];
  const rawOrder = Array.isArray(raw.orderBy) ? raw.orderBy : [];

  if (rawSelect.length === 0) problems.push('select must have at least one item.');
  if (rawSelect.length > LIMITS.select) problems.push(`select can have at most ${LIMITS.select} items.`);
  if (rawFilters.length > LIMITS.filters) problems.push(`filters can have at most ${LIMITS.filters} items.`);
  if (rawOrder.length > LIMITS.orderBy) problems.push(`orderBy can have at most ${LIMITS.orderBy} items.`);

  const select: SelectItem[] = rawSelect.slice(0, LIMITS.select).map((item: unknown, i: number) => {
    const where = `select[${i}]`;
    const s = isObject(item) ? item : {};
    const kind = s.kind;
    const column = typeof s.column === 'string' ? s.column : null;
    const aggregate = AGGREGATES.includes(s.aggregate as Aggregate) ? (s.aggregate as Aggregate) : null;
    const metric = typeof s.metric === 'string' ? s.metric : null;
    const timeGrain = TIME_GRAINS.includes(s.timeGrain as TimeGrain) ? (s.timeGrain as TimeGrain) : null;
    const col = column === null ? undefined : columns.get(column);

    if (kind === 'column') {
      if (!col) problems.push(`${where}: kind "column" needs a column from the table${column ? ` ("${column}" isn't one)` : ''}.`);
      if (timeGrain && col && !TEMPORAL.includes(col.type)) problems.push(`${where}: timeGrain only applies to date or datetime columns ("${col.name}" is ${col.type}).`);
      return { kind, column, aggregate: null, metric: null, timeGrain };
    }
    if (kind === 'aggregate') {
      if (!aggregate) problems.push(`${where}: kind "aggregate" needs an aggregate.`);
      if (column !== null && !col) problems.push(`${where}: "${column}" isn't a column in the table.`);
      if (column === null && aggregate !== 'count') problems.push(`${where}: only count can be used without a column.`);
      if ((aggregate === 'sum' || aggregate === 'avg') && col && !NUMERIC.includes(col.type)) {
        problems.push(`${where}: ${aggregate} needs a numeric column ("${col.name}" is ${col.type}).`);
      }
      if ((aggregate === 'min' || aggregate === 'max') && col && col.type === 'boolean') {
        problems.push(`${where}: ${aggregate} doesn't apply to boolean columns.`);
      }
      return { kind, column, aggregate, metric: null, timeGrain: null };
    }
    if (kind === 'metric') {
      if (!metric || !metrics.has(metric)) problems.push(`${where}: kind "metric" needs one of the table's metrics${metric ? ` ("${metric}" isn't one)` : ''}.`);
      return { kind, column: null, aggregate: null, metric, timeGrain: null };
    }
    problems.push(`${where}: kind must be "column", "aggregate" or "metric".`);
    return { kind: 'column', column, aggregate: null, metric: null, timeGrain: null };
  });

  const filters: Filter[] = rawFilters.slice(0, LIMITS.filters).map((item: unknown, i: number) => {
    const where = `filters[${i}]`;
    const f = isObject(item) ? item : {};
    const column = typeof f.column === 'string' ? f.column : '';
    const operator = OPERATORS.includes(f.operator as Operator) ? (f.operator as Operator) : null;
    const values = Array.isArray(f.values) ? f.values : [];
    const col = columns.get(column);
    if (!col) problems.push(`${where}: "${column}" isn't a column in the table.`);
    if (!operator) problems.push(`${where}: unknown operator.`);
    if (!col || !operator) return { column, operator: operator ?? 'eq', values: [] };

    const expected = expectedValueCount(operator);
    if (expected === 'many') {
      if (values.length < 1 || values.length > LIMITS.values) problems.push(`${where}: ${operator} needs 1 to ${LIMITS.values} values.`);
    } else if (values.length !== expected) {
      problems.push(`${where}: ${operator} needs exactly ${expected} value${expected === 1 ? '' : 's'} (got ${values.length}).`);
    }
    if ((operator === 'contains' || operator === 'starts_with') && col.type !== 'string') {
      problems.push(`${where}: ${operator} only applies to text columns ("${col.name}" is ${col.type}).`);
    }
    if (['gt', 'gte', 'lt', 'lte', 'between'].includes(operator) && col.type === 'boolean') {
      problems.push(`${where}: ${operator} doesn't apply to boolean columns.`);
    }
    const coerced = values.slice(0, LIMITS.values).map((v: unknown, vi: number) => {
      const result = coerceValue(v, col);
      if (typeof result === 'object') {
        problems.push(`${where}.values[${vi}]: ${result.problem}`);
        return String(v);
      }
      return result;
    });
    return { column, operator, values: coerced };
  });

  const seenOrder = new Set<number>();
  const orderBy: OrderBy[] = rawOrder.slice(0, LIMITS.orderBy).flatMap((item: unknown, i: number) => {
    const o = isObject(item) ? item : {};
    const index = o.selectIndex;
    const direction = o.direction === 'desc' ? 'desc' : 'asc';
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= select.length) {
      problems.push(`orderBy[${i}]: selectIndex must point at a select item (0 to ${select.length - 1}).`);
      return [];
    }
    if (seenOrder.has(index)) return [];
    seenOrder.add(index);
    return [{ selectIndex: index, direction }];
  });

  let limit: number | null = null;
  if (raw.limit !== null && raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1) problems.push('limit must be a positive whole number or null.');
    else limit = Math.min(raw.limit, maxRows);
  }

  if (problems.length > 0) throw new SpecError(problems);
  return { explanation, select, filters, orderBy, limit };
}

function expectedValueCount(operator: Operator): number | 'many' {
  switch (operator) {
    case 'in':
    case 'not_in':
      return 'many';
    case 'between':
      return 2;
    case 'is_null':
    case 'is_not_null':
      return 0;
    default:
      return 1;
  }
}

/** Coerce a filter value to the column's type, or explain why it can't be. */
export function coerceValue(value: unknown, column: CatalogColumn): FilterValue | { problem: string } {
  switch (column.type) {
    case 'number':
    case 'integer': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (!Number.isFinite(n)) return { problem: `"${String(value)}" isn't a number (column "${column.name}").` };
      if (column.type === 'integer' && !Number.isInteger(n)) return { problem: `"${String(value)}" isn't a whole number (column "${column.name}").` };
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return { problem: `"${String(value)}" isn't true or false (column "${column.name}").` };
    }
    case 'date': {
      if (typeof value === 'string' && ISO_DATE.test(value.trim()) && isRealDate(value.trim())) return value.trim();
      return { problem: `"${String(value)}" isn't a date in YYYY-MM-DD form (column "${column.name}").` };
    }
    case 'datetime': {
      if (typeof value === 'string') {
        const v = value.trim();
        if ((ISO_DATE.test(v) && isRealDate(v)) || (ISO_DATETIME.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T'))))) return v;
      }
      return { problem: `"${String(value)}" isn't a date or date-time in ISO form (column "${column.name}").` };
    }
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return { problem: `Value for "${column.name}" must be text.` };
  }
}

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
