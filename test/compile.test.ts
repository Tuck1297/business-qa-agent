import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findTable } from '../src/tools/database/catalog.ts';
import { compileQuery, uniqueAliases } from '../src/tools/database/compile.ts';
import { validateSpec, type QuerySpec } from '../src/tools/database/spec.ts';
import { exampleCatalog } from './helpers.ts';

const catalog = exampleCatalog();
const invoices = findTable(catalog, 'sales.v_invoices')!.table;
const tickets = findTable(catalog, 'support.v_tickets')!.table;

function spec(raw: Partial<QuerySpec> & { select: unknown[] }, table = invoices): QuerySpec {
  return validateSpec({ explanation: 'x', filters: [], orderBy: [], limit: null, ...raw }, table, 200);
}

describe('compileQuery — Postgres', () => {
  it('builds a grouped, filtered, sorted query with bound parameters', () => {
    const q = compileQuery(
      spec({
        select: [
          { kind: 'column', column: 'invoice_date', aggregate: null, metric: null, timeGrain: 'month' },
          { kind: 'column', column: 'region', aggregate: null, metric: null, timeGrain: null },
          { kind: 'metric', column: null, aggregate: null, metric: 'revenue', timeGrain: null },
        ],
        filters: [
          { column: 'invoice_date', operator: 'between', values: ['2026-01-01', '2026-06-30'] },
          { column: 'status', operator: 'in', values: ['sent', 'paid'] },
        ],
        orderBy: [{ selectIndex: 2, direction: 'desc' }],
        limit: 10,
      }),
      invoices,
      'postgres',
      200,
    );
    assert.equal(
      q.sql,
      [
        `SELECT date_trunc('month', "invoice_date")::date AS "invoice_date_month",`,
        `       "region" AS "region",`,
        `       (SUM(CASE WHEN status <> 'void' THEN total_amount ELSE 0 END)) AS "revenue"`,
        `FROM "reporting"."v_invoices"`,
        `WHERE "invoice_date" BETWEEN $1 AND $2`,
        `  AND "status" IN ($3, $4)`,
        `GROUP BY date_trunc('month', "invoice_date")::date, "region"`,
        `ORDER BY "revenue" DESC`,
        `LIMIT 11`,
      ].join('\n'),
    );
    assert.deepEqual(q.params, ['2026-01-01', '2026-06-30', 'sent', 'paid']);
    assert.deepEqual(q.columns, ['invoice_date_month', 'region', 'revenue']);
    assert.equal(q.rowLimit, 10);
  });

  it('has no GROUP BY without aggregates, and orders time series oldest-first by default', () => {
    const plain = compileQuery(spec({ select: [{ kind: 'column', column: 'invoice_number', aggregate: null, metric: null, timeGrain: null }] }), invoices, 'postgres', 50);
    assert.doesNotMatch(plain.sql, /GROUP BY|ORDER BY/);
    assert.match(plain.sql, /LIMIT 51$/);

    const series = compileQuery(
      spec({
        select: [
          { kind: 'column', column: 'invoice_date', aggregate: null, metric: null, timeGrain: 'week' },
          { kind: 'aggregate', column: null, aggregate: 'count', metric: null, timeGrain: null },
        ],
      }),
      invoices,
      'postgres',
      50,
    );
    assert.match(series.sql, /COUNT\(\*\) AS "count_all"/);
    assert.match(series.sql, /ORDER BY "invoice_date_week" ASC/);
  });

  it('escapes LIKE wildcards in contains/starts_with values and uses ILIKE', () => {
    const q = compileQuery(
      spec({
        select: [{ kind: 'column', column: 'customer_name', aggregate: null, metric: null, timeGrain: null }],
        filters: [
          { column: 'customer_name', operator: 'contains', values: ['50%_off\\'] },
          { column: 'invoice_number', operator: 'starts_with', values: ['INV-'] },
        ],
      }),
      invoices,
      'postgres',
      200,
    );
    assert.match(q.sql, /"customer_name" ILIKE \$1 ESCAPE '\\'/);
    assert.deepEqual(q.params, ['%50\\%\\_off\\\\%', 'INV-%']);
  });

  it('never puts a value into the SQL text', () => {
    const evil = "x'; DROP TABLE v_invoices; --";
    const q = compileQuery(
      spec({ select: [{ kind: 'column', column: 'status', aggregate: null, metric: null, timeGrain: null }], filters: [{ column: 'customer_name', operator: 'eq', values: [evil] }] }),
      invoices,
      'postgres',
      200,
    );
    assert.ok(!q.sql.includes('DROP'));
    assert.deepEqual(q.params, [evil]);
  });
});

describe('compileQuery — SQL Server', () => {
  it('uses TOP, bracket quoting, @p parameters and safe integer aggregates', () => {
    const q = compileQuery(
      spec(
        {
          select: [
            { kind: 'column', column: 'opened_at', aggregate: null, metric: null, timeGrain: 'month' },
            { kind: 'aggregate', column: 'hours_to_resolve', aggregate: 'avg', metric: null, timeGrain: null },
            { kind: 'aggregate', column: 'ticket_id', aggregate: 'sum', metric: null, timeGrain: null },
            { kind: 'aggregate', column: 'ticket_id', aggregate: 'avg', metric: null, timeGrain: null },
          ],
          filters: [
            { column: 'category', operator: 'eq', values: ['billing'] },
            { column: 'customer_name', operator: 'contains', values: ['[x]_%'] },
          ],
          limit: 12,
        },
        tickets,
      ),
      tickets,
      'sqlserver',
      200,
    );
    assert.equal(
      q.sql,
      [
        'SELECT TOP (13) DATEFROMPARTS(YEAR([opened_at]), MONTH([opened_at]), 1) AS [opened_at_month],',
        '       AVG([hours_to_resolve]) AS [avg_hours_to_resolve],',
        '       SUM(CAST([ticket_id] AS bigint)) AS [sum_ticket_id],',
        '       AVG(CAST([ticket_id] AS float)) AS [avg_ticket_id]',
        'FROM [dbo].[v_tickets]',
        'WHERE [category] = @p1',
        "  AND [customer_name] LIKE @p2 ESCAPE '\\'",
        'GROUP BY DATEFROMPARTS(YEAR([opened_at]), MONTH([opened_at]), 1)',
        'ORDER BY [opened_at_month] ASC',
      ].join('\n'),
    );
    assert.deepEqual(q.params, ['billing', '%\\[x]\\_\\%%']);
  });

  it('has Monday-start week and quarter buckets that don\'t depend on @@DATEFIRST settings', () => {
    const q = compileQuery(
      spec(
        {
          select: [
            { kind: 'column', column: 'opened_at', aggregate: null, metric: null, timeGrain: 'week' },
            { kind: 'column', column: 'closed_at', aggregate: null, metric: null, timeGrain: 'quarter' },
          ],
        },
        tickets,
      ),
      tickets,
      'sqlserver',
      200,
    );
    assert.match(q.sql, /DATEADD\(day, -\(\(DATEPART\(weekday, \[opened_at\]\) \+ @@DATEFIRST \+ 5\) % 7\), CAST\(\[opened_at\] AS date\)\)/);
    assert.match(q.sql, /DATEFROMPARTS\(YEAR\(\[closed_at\]\), \(DATEPART\(quarter, \[closed_at\]\) - 1\) \* 3 \+ 1, 1\)/);
  });
});

describe('uniqueAliases', () => {
  it('names outputs deterministically and de-duplicates', () => {
    assert.deepEqual(
      uniqueAliases([
        { kind: 'column', column: 'status', aggregate: null, metric: null, timeGrain: null },
        { kind: 'column', column: 'status', aggregate: null, metric: null, timeGrain: null },
        { kind: 'aggregate', column: 'total amount', aggregate: 'sum', metric: null, timeGrain: null },
      ]),
      ['status', 'status_2', 'sum_total_amount'],
    );
  });
});
