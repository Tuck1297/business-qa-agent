import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArgumentError, toFunctionTool, validateArguments } from '../src/tools/database/arguments.ts';
import { findTool } from '../src/tools/database/definitions.ts';
import { exampleTools } from './helpers.ts';

const set = exampleTools();
const revenue = findTool(set, 'revenue_by_month')!;
const top = findTool(set, 'top_unpaid_customers')!;

function problems(tool = revenue, raw: unknown): string {
  try {
    validateArguments(tool, raw);
    return '';
  } catch (error) {
    assert.ok(error instanceof ArgumentError);
    return error.problems.join('\n');
  }
}

describe('tool → OpenAI function', () => {
  it('builds a strict schema: every parameter required, optional ones nullable', () => {
    const fn = toFunctionTool(revenue) as any;
    assert.equal(fn.type, 'function');
    assert.equal(fn.name, 'revenue_by_month');
    assert.equal(fn.strict, true);
    assert.equal(fn.parameters.additionalProperties, false);
    assert.deepEqual(fn.parameters.required, ['start_date', 'end_date', 'region']);
    assert.equal(fn.parameters.properties.start_date.type, 'string');
    assert.match(fn.parameters.properties.start_date.description, /Format YYYY-MM-DD/);
    assert.deepEqual(fn.parameters.properties.region.type, ['string', 'null']);
    assert.deepEqual(fn.parameters.properties.region.enum, ['North', 'South', 'Metro', null]);
  });

  it('mentions defaults and ranges in the description', () => {
    const fn = toFunctionTool(top) as any;
    assert.deepEqual(fn.parameters.properties.limit.type, ['integer', 'null']);
    assert.match(fn.parameters.properties.limit.description, /Minimum 1\. Maximum 50\..*default 5/);
  });

  it('never exposes the SQL or the output to the model', () => {
    const text = JSON.stringify(set.tools.map(toFunctionTool));
    assert.ok(!/SELECT|FROM|reporting\./.test(text));
  });
});

describe('validateArguments', () => {
  it('coerces values and fills optional parameters with their default or null', () => {
    assert.deepEqual(validateArguments(revenue, { start_date: '2026-01-01', end_date: '2026-03-31', region: null }), {
      start_date: '2026-01-01',
      end_date: '2026-03-31',
      region: null,
    });
    assert.deepEqual(validateArguments(top, { limit: null, region: 'Metro' }), { limit: 5, region: 'Metro' });
    assert.deepEqual(validateArguments(top, { limit: '10', region: null }), { limit: 10, region: null });
  });

  it('reports every problem', () => {
    const text = problems(revenue, { start_date: '2026-02-30', region: 'East', extra: 1 });
    assert.match(text, /"extra" isn't a parameter/);
    assert.match(text, /"2026-02-30" isn't a date/);
    assert.match(text, /"end_date" is required/);
    assert.match(text, /must be one of "North", "South", "Metro"/);
    assert.match(problems(top, { limit: 500, region: null }), /at most 50/);
    assert.match(problems(top, { limit: 2.5, region: null }), /isn't a whole number/);
    assert.match(problems(top, 'nope'), /JSON object/);
  });

  it('caps string length', () => {
    const lookup = findTool(set, 'invoice_details')!;
    assert.match(problems(lookup, { invoice_number: 'x'.repeat(41) }), /longer than 40/);
  });
});
