import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bindSql, capRows, findNamedParams } from '../src/tools/database/sql.ts';

describe('named parameters', () => {
  it('finds :params but skips casts, strings, quoted identifiers and comments', () => {
    const sql = `SELECT x::date, ':not_a', "col:also_not", '10:30' -- :comment
      /* :block */ FROM t WHERE a = :first AND b IN (:second, :first)`;
    assert.deepEqual(
      findNamedParams(sql, 'postgres').map((p) => p.name),
      ['first', 'second', 'first'],
    );
    assert.deepEqual(
      findNamedParams("SELECT [a:b], 'it''s :x' FROM t WHERE c = :y", 'sqlserver').map((p) => p.name),
      ['y'],
    );
  });

  it('binds Postgres params as typed, reused positional placeholders', () => {
    const bound = bindSql(
      'SELECT * FROM t WHERE d BETWEEN :start AND :end AND (:region IS NULL OR region = :region)',
      'postgres',
      { start: 'date', end: 'date', region: 'string' },
      { start: '2026-01-01', end: '2026-01-31', region: null },
    );
    assert.equal(
      bound.text,
      'SELECT * FROM t WHERE d BETWEEN ($1::date) AND ($2::date) AND (($3::text) IS NULL OR region = ($3::text))',
    );
    assert.deepEqual(
      bound.params.map((p) => p.value),
      ['2026-01-01', '2026-01-31', null],
    );
  });

  it('binds SQL Server params by prefixed name, once each', () => {
    const bound = bindSql(
      'SELECT * FROM t WHERE n > :n AND m < :n AND f = :flag',
      'sqlserver',
      { n: 'integer', flag: 'boolean' },
      { n: 3, flag: true },
    );
    assert.equal(bound.text, 'SELECT * FROM t WHERE n > @p_n AND m < @p_n AND f = @p_flag');
    assert.deepEqual(bound.params, [
      { name: 'p_n', value: 3, type: 'integer' },
      { name: 'p_flag', value: true, type: 'boolean' },
    ]);
  });

  it('refuses undeclared or missing parameters', () => {
    assert.throws(() => bindSql('SELECT :x', 'postgres', {}, {}), /isn't a declared parameter/);
    assert.throws(() => bindSql('SELECT :x', 'postgres', { x: 'string' }, {}), /No value for parameter :x/);
  });

  it('caps rows with one extra row to detect truncation', () => {
    assert.equal(capRows('SELECT 1', 'postgres', 10), 'SELECT * FROM (\nSELECT 1\n) AS capped_result\nLIMIT 11');
    assert.equal(
      capRows('SELECT 1 ORDER BY 1', 'sqlserver', 10),
      'SET ROWCOUNT 11;\nSELECT 1 ORDER BY 1;\nSET ROWCOUNT 0;',
    );
  });
});
