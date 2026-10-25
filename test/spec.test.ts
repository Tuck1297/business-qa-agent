import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findTable } from '../src/tools/database/catalog.ts';
import { buildSpecSchema, SpecError, validateSpec } from '../src/tools/database/spec.ts';
import { exampleCatalog } from './helpers.ts';

const invoices = findTable(exampleCatalog(), 'sales.v_invoices')!.table;
const customers = findTable(exampleCatalog(), 'sales.v_customers')!.table;

const base = { explanation: 'x', select: [], filters: [], orderBy: [], limit: null };
const col = (column: string, timeGrain: string | null = null) => ({ kind: 'column', column, aggregate: null, metric: null, timeGrain });
const agg = (aggregate: string, column: string | null) => ({ kind: 'aggregate', column, aggregate, metric: null, timeGrain: null });
const metric = (name: string) => ({ kind: 'metric', column: null, aggregate: null, metric: name, timeGrain: null });

function problemsOf(raw: unknown, table = invoices): string[] {
  try {
    validateSpec(raw, table, 200);
  } catch (error) {
    if (error instanceof SpecError) return error.problems;
    throw error;
  }
  return [];
}

/** Recursively check the strict-mode rules OpenAI enforces on every object in a schema. */
function assertStrict(schema: unknown, path = '$'): void {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as Record<string, unknown>;
  if (s.type === 'object') {
    assert.equal(s.additionalProperties, false, `${path}: additionalProperties must be false`);
    const keys = Object.keys((s.properties as Record<string, unknown>) ?? {});
    assert.deepEqual([...(s.required as string[])].sort(), keys.sort(), `${path}: every property must be required`);
  }
  for (const [key, value] of Object.entries(s)) {
    if (Array.isArray(value)) value.forEach((v, i) => assertStrict(v, `${path}.${key}[${i}]`));
    else assertStrict(value, `${path}.${key}`);
  }
}

describe('query spec schema', () => {
  it('lists only the table\'s columns and metrics as enums', () => {
    const schema = buildSpecSchema(invoices, 200) as any;
    const item = schema.properties.select.items.properties;
    assert.deepEqual(item.column.enum, [...invoices.columns.map((c) => c.name), null]);
    assert.deepEqual(item.metric.enum, ['revenue', 'outstanding_balance', null]);
    assert.deepEqual(schema.properties.filters.items.properties.column.enum, invoices.columns.map((c) => c.name));
  });

  it('meets strict-mode rules (additionalProperties false, everything required)', () => {
    assertStrict(buildSpecSchema(invoices, 200));
    assertStrict(buildSpecSchema(customers, 200));
  });

  it('uses a null-only metric field for tables without metrics', () => {
    const schema = buildSpecSchema(customers, 50) as any;
    assert.deepEqual(schema.properties.select.items.properties.metric, {
      type: 'null',
      description: schema.properties.select.items.properties.metric.description,
    });
  });
});

describe('validateSpec', () => {
  it('accepts a good plan, coerces values and caps the limit', () => {
    const spec = validateSpec(
      {
        ...base,
        select: [col('invoice_date', 'month'), metric('revenue')],
        filters: [
          { column: 'invoice_date', operator: 'between', values: ['2026-01-01', '2026-06-30'] },
          { column: 'total_amount', operator: 'gt', values: ['100'] },
        ],
        orderBy: [{ selectIndex: 0, direction: 'asc' }],
        limit: 5000,
      },
      invoices,
      200,
    );
    assert.equal(spec.limit, 200);
    assert.deepEqual(spec.filters[1]!.values, [100]);
  });

  it('rejects unknown columns, wrong aggregates and wrong time grains', () => {
    const problems = problemsOf({
      ...base,
      select: [col('nope'), agg('sum', 'customer_name'), col('customer_name', 'month'), agg('avg', null), metric('profit')],
    });
    assert.equal(problems.length, 5, problems.join('\n'));
    assert.match(problems.join('\n'), /"nope" isn't one/);
    assert.match(problems.join('\n'), /sum needs a numeric column/);
    assert.match(problems.join('\n'), /timeGrain only applies/);
    assert.match(problems.join('\n'), /only count can be used without a column/);
    assert.match(problems.join('\n'), /"profit" isn't one/);
  });

  it('checks value counts and types per operator', () => {
    const problems = problemsOf({
      ...base,
      select: [agg('count', null)],
      filters: [
        { column: 'invoice_date', operator: 'between', values: ['2026-01-01'] },
        { column: 'invoice_date', operator: 'eq', values: ['January'] },
        { column: 'invoice_date', operator: 'eq', values: ['2026-02-30'] },
        { column: 'total_amount', operator: 'contains', values: ['1'] },
        { column: 'status', operator: 'in', values: [] },
        { column: 'status', operator: 'is_null', values: ['x'] },
        { column: 'total_amount', operator: 'eq', values: ['ten'] },
      ],
    });
    const text = problems.join('\n');
    assert.match(text, /between needs exactly 2 values/);
    assert.match(text, /"January" isn't a date/);
    assert.match(text, /"2026-02-30" isn't a date/);
    assert.match(text, /contains only applies to text columns/);
    assert.match(text, /in needs 1 to 100 values/);
    assert.match(text, /is_null needs exactly 0 values/);
    assert.match(text, /"ten" isn't a number/);
  });

  it('coerces booleans and rejects non-boolean values', () => {
    const ok = validateSpec({ ...base, select: [agg('count', null)], filters: [{ column: 'is_active', operator: 'eq', values: ['true'] }] }, customers, 10);
    assert.deepEqual(ok.filters[0]!.values, [true]);
    assert.match(problemsOf({ ...base, select: [agg('count', null)], filters: [{ column: 'is_active', operator: 'eq', values: ['yes'] }] }, customers).join(), /isn't true or false/);
    assert.match(problemsOf({ ...base, select: [agg('max', 'is_active')] }, customers).join(), /doesn't apply to boolean/);
  });

  it('rejects an empty select, a bad orderBy index and a bad limit', () => {
    assert.match(problemsOf(base).join(), /at least one item/);
    assert.match(problemsOf({ ...base, select: [col('status')], orderBy: [{ selectIndex: 3, direction: 'asc' }] }).join(), /selectIndex/);
    assert.match(problemsOf({ ...base, select: [col('status')], limit: 0 }).join(), /limit/);
    assert.match(problemsOf('not an object').join(), /JSON object/);
  });

  it('drops duplicate orderBy entries', () => {
    const spec = validateSpec(
      { ...base, select: [col('status')], orderBy: [{ selectIndex: 0, direction: 'asc' }, { selectIndex: 0, direction: 'desc' }] },
      invoices,
      200,
    );
    assert.deepEqual(spec.orderBy, [{ selectIndex: 0, direction: 'asc' }]);
  });
});
