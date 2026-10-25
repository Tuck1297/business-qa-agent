import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapType } from '../scripts/draft-catalog.ts';
import { describeTableForSelection, findTable, listTables, validateCatalog } from '../src/tools/database/catalog.ts';
import { exampleCatalog } from './helpers.ts';

describe('catalog', () => {
  it('accepts the example catalog and lists every table with a stable id', () => {
    const catalog = exampleCatalog();
    assert.deepEqual(
      listTables(catalog).map((t) => t.id),
      ['sales.v_invoices', 'sales.v_customers', 'support.v_tickets'],
    );
    assert.equal(findTable(catalog, 'support.v_tickets')?.source.engine, 'sqlserver');
    assert.equal(findTable(catalog, 'nope.table'), undefined);
  });

  it('reports every problem at once', () => {
    assert.throws(
      () =>
        validateCatalog({
          sources: [
            {
              name: 'bad name',
              engine: 'oracle',
              connectionEnv: 'lowercase',
              tables: [
                {
                  name: 't1',
                  description: '',
                  columns: [
                    { name: 'a', type: 'text', description: 'x' },
                    { name: 'a', type: 'string', description: 'dup' },
                  ],
                  metrics: [{ name: 'm', description: 'x', sql: 'SUM(a); DROP TABLE t1' }],
                },
              ],
            },
          ],
        }),
      (error: Error) => {
        for (const expected of ['simple name', 'engine', 'connectionEnv', 'description is required', 'type must be', 'used twice', 'single expression']) {
          assert.match(error.message, new RegExp(expected), `missing "${expected}" in:\n${error.message}`);
        }
        return true;
      },
    );
  });

  it('rejects a catalog without sources', () => {
    assert.throws(() => validateCatalog({}), /sources/);
    assert.throws(() => validateCatalog({ sources: [] }), /no sources/);
  });

  it('describes a table for selection with columns, metrics and examples, within the length cap', () => {
    const ref = findTable(exampleCatalog(), 'sales.v_invoices')!;
    const text = describeTableForSelection(ref);
    assert.match(text, /One row per invoice/);
    assert.match(text, /Columns: invoice_number, customer_name/);
    assert.match(text, /Metrics: revenue, outstanding_balance/);
    assert.ok(describeTableForSelection(ref, 80).length <= 80);
  });

  it('maps database types to catalog column types', () => {
    assert.equal(mapType('integer'), 'integer');
    assert.equal(mapType('bigint'), 'integer');
    assert.equal(mapType('numeric'), 'number');
    assert.equal(mapType('double precision'), 'number');
    assert.equal(mapType('money'), 'number');
    assert.equal(mapType('bit'), 'boolean');
    assert.equal(mapType('date'), 'date');
    assert.equal(mapType('timestamp with time zone'), 'datetime');
    assert.equal(mapType('datetime2'), 'datetime');
    assert.equal(mapType('nvarchar'), 'string');
    assert.equal(mapType('uuid'), 'string');
  });
});
