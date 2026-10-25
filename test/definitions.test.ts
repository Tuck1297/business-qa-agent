import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSql, findTool, sourceOf, validateTools } from '../src/tools/database/definitions.ts';
import { exampleTools } from './helpers.ts';

const source = { name: 'sales', engine: 'postgres', connectionEnv: 'SALES_DATABASE_URL' };
const goodTool = {
  name: 'revenue_total',
  description: 'Total revenue between two dates.',
  source: 'sales',
  parameters: [{ name: 'start_date', type: 'date', description: 'First day.' }],
  sql: 'SELECT SUM(total) AS revenue FROM v WHERE d >= :start_date',
  output: [{ name: 'revenue', description: 'Revenue.', format: 'currency' }],
};

function problems(tools: unknown[], sources: unknown[] = [source]): string {
  try {
    validateTools({ sources, tools });
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('tool definitions', () => {
  it('accepts the example tools file', () => {
    const set = exampleTools();
    assert.equal(set.tools.length, 6);
    assert.equal(sourceOf(set, findTool(set, 'open_tickets_by_priority')!).engine, 'sqlserver');
    assert.equal(problems([goodTool]), '');
  });

  it('requires a usable name, a description and a known source', () => {
    const text = problems([{ ...goodTool, name: 'Revenue Total', description: 'short', source: 'nope' }]);
    assert.match(text, /snake_case/);
    assert.match(text, /description is required/);
    assert.match(text, /source "nope" isn't one of the sources/);
  });

  it('cross-checks :params in the SQL against declared parameters', () => {
    const text = problems([
      { ...goodTool, sql: 'SELECT SUM(total) AS revenue FROM v WHERE d >= :start AND r = :region' },
    ]);
    assert.match(text, /uses :start, which isn't a declared parameter/);
    assert.match(text, /uses :region, which isn't a declared parameter/);
    assert.match(text, /parameter "start_date" is declared but the SQL never uses :start_date/);
  });

  it('only allows a single SELECT or WITH statement', () => {
    assert.match(problems([{ ...goodTool, sql: 'DELETE FROM v WHERE d >= :start_date' }]), /single SELECT/);
    assert.match(
      problems([{ ...goodTool, sql: 'SELECT 1 AS revenue WHERE :start_date IS NOT NULL; DROP TABLE v' }]),
      /one statement/,
    );
    assert.deepEqual(checkSql("-- totals\nWITH x AS (SELECT ';' AS s) SELECT s FROM x; ", 'postgres'), []);
    assert.deepEqual(checkSql('/* a; b */ SELECT [a;b] FROM t', 'sqlserver'), []);
  });

  it('checks parameter types, enums, defaults and output fields', () => {
    const text = problems([
      {
        ...goodTool,
        parameters: [
          { name: 'start_date', type: 'when', description: 'x' },
          { name: 'n', type: 'integer', description: 'x', enum: ['a'], default: 'five' },
        ],
        sql: 'SELECT 1 AS revenue WHERE :start_date IS NOT NULL AND :n > 0',
        output: [
          { name: 'total revenue', description: 'x' },
          { name: 'r', description: 'x', format: 'money' },
        ],
      },
    ]);
    assert.match(text, /type must be one of/);
    assert.match(text, /enum values must match/);
    assert.match(text, /default doesn't match/);
    assert.match(text, /name must be letters, digits and _/);
    assert.match(text, /format must be one of/);
  });

  it('rejects duplicate tools and bad sources', () => {
    const text = problems([goodTool, goodTool], [source, { ...source, engine: 'oracle', connectionEnv: 'lower' }]);
    assert.match(text, /used twice/);
    assert.match(text, /engine must be/);
    assert.match(text, /connectionEnv must name an environment variable/);
    assert.throws(() => validateTools({ tools: [] }), /"sources" and "tools" arrays/);
  });
});
