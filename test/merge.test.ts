import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyReport, formatValue, renderTemplate, StreamingMerger, tidy, truncationNote, UNAVAILABLE, type MergeOptions, type MergeSource } from '../src/merge/merge.ts';

const options: MergeOptions = { locale: 'en-US', currency: 'USD', timeZone: 'America/Chicago' };

const top: MergeSource = {
  id: 'top_unpaid_customers',
  tool: 'top_unpaid_customers',
  fields: [
    { name: 'customer_name', description: 'Customer', label: 'Customer' },
    { name: 'balance', description: 'Balance', format: 'currency', label: 'Unpaid balance' },
    { name: 'open_invoices', description: 'Open', format: 'integer' },
  ],
  status: 'ok',
  rows: [
    { customer_name: 'Lakeside Dental', balance: '900.00', open_invoices: '2' },
    { customer_name: 'Birch | Co.', balance: '500.5', open_invoices: '1' },
    { customer_name: 'Save 50% Shop', balance: 300, open_invoices: 1 },
  ],
  truncated: false,
  rowLimit: 200,
};
const months: MergeSource = {
  id: 'revenue_by_month',
  tool: 'revenue_by_month',
  fields: [
    { name: 'month', description: 'Month', format: 'month' },
    { name: 'revenue', description: 'Revenue', format: 'currency' },
  ],
  status: 'ok',
  rows: [
    { month: '2026-01-01', revenue: '1500.00' },
    { month: '2026-02-01', revenue: '1050.00' },
  ],
  truncated: true,
  rowLimit: 2,
};
const empty: MergeSource = { ...top, id: 'overdue', rows: [], truncated: false };
const failed: MergeSource = { ...top, id: 'broken', status: 'failed', rows: [] };
const sources = [top, months, empty, failed];

const render = (template: string) => {
  const report = emptyReport();
  return { text: renderTemplate(template, sources, options, report), report };
};

describe('merge fields', () => {
  it('fills single values from the first or nth row, formatted', () => {
    const { text, report } = render('{{top_unpaid_customers.customer_name}} owes {{ top_unpaid_customers.balance }}; next is {{top_unpaid_customers[2].customer_name}} ({{top_unpaid_customers[2].balance}}).');
    assert.equal(text, 'Lakeside Dental owes $900.00; next is Birch | Co. ($500.50).');
    assert.equal(report.fields, 4);
    assert.deepEqual(report.usedCalls, ['top_unpaid_customers']);
  });

  it('renders counts, lists and aggregates', () => {
    assert.equal(render('{{count top_unpaid_customers}}').text, '3');
    assert.equal(render('{{list top_unpaid_customers.customer_name}}').text, 'Lakeside Dental, Birch | Co., and Save 50% Shop');
    assert.equal(render('{{sum top_unpaid_customers.balance}}').text, '$1,700.50');
    assert.equal(render('{{avg top_unpaid_customers.open_invoices}}').text, '1');
    assert.equal(render('{{max top_unpaid_customers.balance}} / {{min top_unpaid_customers.balance}}').text, '$900.00 / $300.00');
    assert.equal(render('{{max revenue_by_month.month}}').text, 'Feb 2026');
  });

  it('renders a markdown table with labels, right-aligned numbers and escaped pipes', () => {
    const table = render('{{table top_unpaid_customers}}').text;
    assert.equal(
      tidy(table),
      [
        '| Customer | Unpaid balance | open_invoices |',
        '| --- | ---: | ---: |',
        '| Lakeside Dental | $900.00 | 2 |',
        '| Birch \\| Co. | $500.50 | 1 |',
        '| Save 50% Shop | $300.00 | 1 |',
      ].join('\n'),
    );
  });

  it('marks truncated results in counts, lists, tables and the report', () => {
    const { text, report } = render('{{count revenue_by_month}} months: {{list revenue_by_month.revenue}} {{table revenue_by_month}}');
    assert.match(text, /^2\+ months: \$1,500\.00, \$1,050\.00, and more/);
    assert.match(text, /_Showing the first 2 rows\._/);
    assert.deepEqual(report.truncatedCalls, ['revenue_by_month']);
    assert.match(truncationNote(report, sources)!, /cut off at the row limit \(2\)/);
    assert.equal(truncationNote(render('{{count overdue}}').report, sources), null);
  });

  it('handles empty results, failed calls and bad references without leaking a raw field', () => {
    const { text, report } = render('A: {{overdue.customer_name}} B: {{table overdue}} C: {{count overdue}} D: {{list overdue.customer_name}} E: {{sum overdue.balance}} F: {{broken.customer_name}} G: {{nope.x}} H: {{top_unpaid_customers.nope}} I: {{whatever this is}} J: {{top_unpaid_customers[9].customer_name}}');
    assert.equal(
      tidy(text),
      `A: — B:\n\n_No matching records._\n\nC: 0 D: none E: — F: ${UNAVAILABLE} G: ${UNAVAILABLE} H: ${UNAVAILABLE} I: ${UNAVAILABLE} J: —`,
    );
    assert.deepEqual(report.emptyCalls, ['overdue']);
    assert.deepEqual(report.unresolved.map((u) => u.reason), [
      'the "broken" data couldn\'t be retrieved',
      'there\'s no data call "nope"',
      '"top_unpaid_customers" has no field "nope"',
      'not a recognized merge field',
    ]);
    assert.ok(!text.includes('{{'));
  });

  it('formats values by field format', () => {
    assert.equal(formatValue('0.125', 'percent', options), '12.5%');
    assert.equal(formatValue(1234.567, 'number', options), '1,234.57');
    assert.equal(formatValue('2026-03-09', 'date', options), 'Mar 9, 2026');
    assert.equal(formatValue('2026-03-09T00:00:00.000Z', 'date', options), 'Mar 9, 2026');
    assert.equal(formatValue('2026-10-25T15:30:00Z', 'datetime', options), 'Oct 25, 2026, 10:30 AM');
    assert.equal(formatValue('t', 'boolean', options), 'Yes');
    assert.equal(formatValue(0, 'boolean', options), 'No');
    assert.equal(formatValue(null, 'currency', options), '—');
    assert.equal(formatValue('n/a', 'currency', options), 'n/a');
    assert.equal(formatValue(1500, 'currency', { ...options, locale: 'de-DE', currency: 'EUR' }), '1.500,00\u00a0€');
  });
});

describe('StreamingMerger', () => {
  it('never emits a raw or half merge field, even when fields split across deltas', () => {
    const merger = new StreamingMerger(sources, options);
    const deltas = ['The top customer is {', '{top_unpaid', '_customers.custo', 'mer_name}', '} with {{top_unpaid_customers.balance}}', ' owed.'];
    const out = deltas.map((d) => merger.push(d));
    out.push(merger.end());
    for (const piece of out) assert.ok(!piece.includes('{') && !piece.includes('}'), `leaked: ${JSON.stringify(piece)}`);
    assert.equal(out.join(''), 'The top customer is Lakeside Dental with $900.00 owed.');
    assert.equal(merger.report.fields, 2);
  });

  it('streams plain text immediately and lets an unclosed "{{" through after a while', () => {
    const merger = new StreamingMerger(sources, options);
    assert.equal(merger.push('Hello '), 'Hello ');
    assert.equal(merger.push('{{ not closed '), '');
    const long = merger.push('x'.repeat(250));
    assert.ok(long.startsWith('{{ not closed'));
    assert.equal(merger.push('{'), '');
    assert.equal(merger.end(), '{');
  });
});
