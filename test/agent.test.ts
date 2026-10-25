import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Agent, formatDate, type AgentOptions } from '../src/agent/agent.ts';
import type { AgentEvent } from '../src/events.ts';
import type { DocumentSearch } from '../src/tools/documents/aiSearch.ts';
import { DatabaseService } from '../src/tools/database/service.ts';
import { call, decider, eventTypes, exampleTools, FakeLlm, routeAnswers, type FakeLlmScript } from './helpers.ts';

// Values that must never reach the model provider.
const SECRET_CUSTOMER = 'Zephyr Private Holdings';
const SECRET_BALANCE = '98765.43';
const SECRET_INVOICE = 'INV-SECRET-7731';

const ROWS: Record<string, Record<string, unknown>[]> = {
  top_unpaid_customers: [
    { customer_name: SECRET_CUSTOMER, balance: SECRET_BALANCE, open_invoices: '3' },
    { customer_name: 'Lakeside Dental', balance: '900.00', open_invoices: '2' },
  ],
  overdue_invoices: [{ invoice_number: SECRET_INVOICE, customer_name: SECRET_CUSTOMER, due_date: '2026-09-01', balance: SECRET_BALANCE, days_overdue: 54 }],
  revenue_by_month: [{ month: '2026-01-01', revenue: '1500.00', invoices: '2' }],
};

const docs: DocumentSearch = {
  async search() {
    return [{ id: 'c1', source: 'policies/billing-terms.pdf', text: 'Invoices are due in 30 days.', score: 0.82, timestamp: null }];
  },
};

function makeAgent(script: FakeLlmScript, overrides: Partial<AgentOptions> = {}, opts: { failTool?: string; maxRows?: number } = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const database = new DatabaseService(exampleTools(), {
    timeoutMs: 1000,
    maxRows: opts.maxRows ?? 200,
    env: { SALES_DATABASE_URL: 'postgres://test', SUPPORT_DATABASE_URL: 'mssql://test' },
    factory: async () => ({
      async query(sql, params) {
        queries.push({ sql, params });
        const tool = Object.keys(ROWS).find((name) => sql.includes(name === 'top_unpaid_customers' ? 'HAVING' : name === 'overdue_invoices' ? 'days_overdue' : "date_trunc('month'"));
        if (opts.failTool && tool === opts.failTool) throw new Error(`relation "secret_${SECRET_CUSTOMER}" does not exist`);
        return tool ? ROWS[tool]! : [];
      },
      async close() {},
    }),
  });
  const llm = new FakeLlm(script);
  const agent = new Agent({
    llm,
    database,
    documents: docs,
    documentsDescription: 'policies and contracts',
    timezone: 'America/Chicago',
    locale: 'en-US',
    currency: 'USD',
    showSql: true,
    maxToolCalls: 4,
    toolSelectThreshold: 0.5,
    predicateThreshold: 0.5,
    clarifyThreshold: 0.7,
    now: () => new Date('2026-10-25T15:00:00Z'),
    ...overrides,
  });
  return { agent, llm, queries };
}

async function run(agent: Agent, question: string) {
  const events: AgentEvent[] = [];
  const result = await agent.ask(question, (e) => events.push(e));
  return { result, events };
}

const deltas = (events: AgentEvent[]) => events.filter((e) => e.type === 'answer.delta').map((e) => (e as { text: string }).text);

describe('Agent — database tools and merge fields', () => {
  it('never sends database values to the model, and fills them into the answer and the response', async () => {
    const { agent, llm, queries } = makeAgent({
      decide: decider({ purpose: 'data_and_documents', db: 0.9, docs: 0.8 }, { top_unpaid_customers: 0.93, overdue_invoices: 0.71 }),
      callTools: () => [call('top_unpaid_customers', { limit: 2, region: null }), call('overdue_invoices', { as_of: '2026-10-25', region: null })],
      stream: () => [
        'The largest unpaid balance belongs to {{top_unpaid_customers.customer_name}} ({{top_unp',
        'aid_customers.balance}}). ',
        '{{table top_unpaid_customers}}',
        'Overdue invoices: {{count overdue_invoices}}, totaling {{sum overdue_invoices.balance}}. Invoices are due in 30 days [D1].',
      ],
    });
    const { result, events } = await run(agent, 'Who owes us the most, how much is overdue, and what are our payment terms?');

    // 1. Nothing from the rows reached the model.
    const sent = llm.everythingSent();
    for (const secret of [SECRET_CUSTOMER, SECRET_BALANCE, SECRET_INVOICE, '98,765.43', 'Lakeside Dental']) {
      assert.ok(!sent.includes(secret), `"${secret}" was sent to the model`);
    }

    // 2. The client got the values: merged answer, merged deltas, raw rows.
    assert.match(result.answer, /^The largest unpaid balance belongs to Zephyr Private Holdings \(\$98,765\.43\)\./);
    assert.match(result.answer, /\| Customer \| Unpaid balance \| Open invoices \|/);
    assert.match(result.answer, /\| Lakeside Dental \| \$900\.00 \| 2 \|/);
    assert.match(result.answer, /Overdue invoices: 1, totaling \$98,765\.43\./);
    const streamed = deltas(events).join('');
    assert.ok(!streamed.includes('{{') && !streamed.includes('}}'), 'a raw merge field was streamed');
    assert.match(streamed, /Zephyr Private Holdings \(\$98,765\.43\)/);
    assert.equal(result.answerTemplate?.includes('{{top_unpaid_customers.customer_name}}'), true);
    assert.deepEqual(result.data.map((d) => [d.id, d.status, d.rowCount]), [['top_unpaid_customers', 'ok', 2], ['overdue_invoices', 'ok', 1]]);
    assert.equal(result.data[0]!.rows[0]!.customer_name, SECRET_CUSTOMER);
    assert.deepEqual(result.merge?.usedCalls, ['top_unpaid_customers', 'overdue_invoices']);
    assert.deepEqual(result.merge?.unresolved, []);
    assert.deepEqual(result.citations.map((c) => `${c.kind}:${c.id}`), ['data:top_unpaid_customers', 'data:overdue_invoices', 'document:D1']);

    // 3. Your SQL ran with the model's arguments bound as parameters.
    assert.equal(queries.length, 2);
    assert.ok(queries.every((q) => !q.sql.includes('2026-10-25')));
    assert.ok(queries.some((q) => JSON.stringify(q.params).includes('2026-10-25')));

    // 4. Steps, with one run_tool per call.
    const types = eventTypes(events);
    for (const key of ['route', 'select_tools', 'plan_tool_calls', 'run_tool:top_unpaid_customers', 'run_tool:overdue_invoices', 'search_documents', 'write_answer']) {
      assert.ok(types.includes(`step.completed:${key}`), `missing ${key} in ${types.join(', ')}`);
    }
  });

  it('shows the model only call ids, arguments and field descriptions, and only the shortlisted tools', async () => {
    const { agent, llm } = makeAgent({
      decide: decider({ purpose: 'business_data', db: 0.9 }, { revenue_by_month: 0.88, invoice_details: 0.4 }),
      callTools: () => [call('revenue_by_month', { start_date: '2026-01-01', end_date: '2026-10-25', region: null })],
      stream: () => ['{{table revenue_by_month}}'],
    });
    await run(agent, 'Revenue by month this year?');

    const selection = llm.calls.filter((c) => c.kind === 'decide')[1]!.payload as { input: string; questions: Array<{ name: string; type: string; instructions: string }> };
    assert.equal(selection.questions.length, 6);
    assert.ok(selection.questions.every((q) => q.type === 'predicate'));
    assert.match(selection.input, /Today: 2026-10-25 \(America\/Chicago\)/);

    const planning = llm.calls.find((c) => c.kind === 'callTools')!.payload as { instructions: string; tools: Array<{ name: string }> };
    assert.deepEqual(planning.tools.map((t) => t.name), ['revenue_by_month']);
    assert.match(planning.instructions, /Today is 2026-10-25/);
    assert.ok(!JSON.stringify(planning).includes('SELECT'), 'SQL was sent to the model');

    const answer = llm.calls.find((c) => c.kind === 'stream')!.payload as { instructions: string; input: string };
    assert.match(answer.input, /Call id: revenue_by_month/);
    assert.match(answer.input, /Ran with: start_date = 2026-01-01, end_date = 2026-10-25, region = not set/);
    assert.match(answer.input, /Rows: One row per month that has invoices, oldest month first\./);
    assert.match(answer.input, /- revenue \(currency\): Invoiced revenue in the month/);
    assert.match(answer.instructions, /DATABASE VALUES ARE HIDDEN FROM YOU/);
    assert.ok(!answer.input.includes('1500') && !answer.input.includes('2026-01-01T'), 'row values reached the answer prompt');
  });

  it('gives repeat calls their own ids and caps the number of calls', async () => {
    const { agent, queries } = makeAgent(
      {
        decide: decider({ purpose: 'business_data', db: 0.9 }, { revenue_by_month: 0.9 }),
        callTools: () => [
          call('revenue_by_month', { start_date: '2026-01-01', end_date: '2026-06-30', region: null }),
          call('revenue_by_month', { start_date: '2025-01-01', end_date: '2025-06-30', region: null }),
          call('revenue_by_month', { start_date: '2024-01-01', end_date: '2024-06-30', region: null }),
        ],
        stream: () => ['This year: {{sum revenue_by_month.revenue}}. Last year: {{sum revenue_by_month_2.revenue}}.'],
      },
      { maxToolCalls: 2 },
    );
    const { result, events } = await run(agent, 'Compare first-half revenue this year and last year.');
    assert.deepEqual(result.data.map((d) => d.id), ['revenue_by_month', 'revenue_by_month_2']);
    assert.equal(queries.length, 2);
    assert.equal(result.answer, 'This year: $1,500.00. Last year: $1,500.00.');
    const plan = events.find((e) => e.type === 'step.completed' && e.step === 'plan_tool_calls') as Extract<AgentEvent, { type: 'step.completed' }>;
    assert.equal(plan.data.dropped, 1);
  });

  it('retries once when the model sends invalid arguments', async () => {
    const { agent, llm } = makeAgent({
      decide: decider({ purpose: 'business_data', db: 0.9 }, { revenue_by_month: 0.9 }),
      callTools: (_req, n) =>
        n === 1
          ? [call('revenue_by_month', { start_date: 'last month', end_date: '2026-10-25', region: 'East' })]
          : [call('revenue_by_month', { start_date: '2026-09-01', end_date: '2026-09-30', region: null })],
      stream: () => ['{{revenue_by_month.revenue}}'],
    });
    const { events } = await run(agent, 'Revenue last month?');
    const second = llm.calls.filter((c) => c.kind === 'callTools')[1]!.payload as { input: string };
    assert.match(second.input, /previous tool call was rejected/);
    assert.match(second.input, /"last month" isn't a date/);
    assert.match(second.input, /must be one of "North", "South", "Metro"/);
    const plan = events.find((e) => e.type === 'step.completed' && e.step === 'plan_tool_calls') as Extract<AgentEvent, { type: 'step.completed' }>;
    assert.equal(plan.data.attempts, 2);
  });

  it('keeps going when a tool fails, without passing the database error to the model', async () => {
    const { agent, llm } = makeAgent(
      {
        decide: decider({ purpose: 'business_data', db: 0.9 }, { top_unpaid_customers: 0.9, revenue_by_month: 0.8 }),
        callTools: () => [call('top_unpaid_customers', { limit: null, region: null }), call('revenue_by_month', { start_date: '2026-01-01', end_date: '2026-10-25', region: null })],
        stream: () => ['Top: {{top_unpaid_customers.customer_name}}. Revenue: {{sum revenue_by_month.revenue}}.'],
      },
      {},
      { failTool: 'top_unpaid_customers' },
    );
    const { result, events } = await run(agent, 'Who owes the most and what is revenue this year?');
    assert.ok(eventTypes(events).includes('step.failed:run_tool:top_unpaid_customers'));
    assert.equal(eventTypes(events).at(-1), 'run.completed');
    assert.equal(result.answer, 'Top: [unavailable]. Revenue: $1,500.00.');
    assert.equal(result.data[0]!.status, 'failed');
    assert.match(result.data[0]!.error!, /does not exist/);
    const answerPrompt = llm.calls.find((c) => c.kind === 'stream')!.payload as { input: string };
    assert.match(answerPrompt.input, /STATUS: this data couldn't be retrieved/);
    assert.ok(!llm.everythingSent().includes(SECRET_CUSTOMER), 'the database error text reached the model');
  });

  it('says so when no defined tool fits', async () => {
    const { agent, llm, queries } = makeAgent({
      decide: decider({ purpose: 'business_data', db: 0.9 }, {}),
      stream: () => ["I don't have a tool for employee headcount."],
    });
    const { result } = await run(agent, 'How many employees do we have?');
    assert.equal(queries.length, 0);
    assert.equal(llm.calls.filter((c) => c.kind === 'callTools').length, 0);
    assert.match((llm.calls.at(-1)!.payload as { input: string }).input, /none of the defined database tools fits this question/);
    assert.equal(result.answerTemplate, null);
    assert.equal(result.merge, null);
  });

  it('adds a note when a result was cut off at the row cap', async () => {
    const { agent } = makeAgent(
      {
        decide: decider({ purpose: 'business_data', db: 0.9 }, { top_unpaid_customers: 0.9 }),
        callTools: () => [call('top_unpaid_customers', { limit: 10, region: null })],
        stream: () => ['{{list top_unpaid_customers.customer_name}}'],
      },
      {},
      { maxRows: 1 },
    );
    const { result, events } = await run(agent, 'Who owes us money?');
    assert.match(result.answer, /^Zephyr Private Holdings and more\n\n_Note: some results were cut off at the row limit \(1\)/);
    assert.match(deltas(events).join(''), /_Note: some results were cut off/);
  });
});

describe('Agent — other routes', () => {
  it('asks a follow-up without touching the tools when the question is ambiguous', async () => {
    const { agent, llm, queries } = makeAgent({
      decide: () => routeAnswers({ purpose: 'unclear', ambiguous: 0.9 }),
      stream: () => ['Which period do you mean: this month or this year?'],
    });
    const { events, result } = await run(agent, 'How are we doing?');
    assert.deepEqual(eventTypes(events), ['run.started', 'step.started:route', 'step.completed:route', 'step.started:write_answer', 'step.completed:write_answer', 'run.completed']);
    assert.equal(queries.length, 0);
    assert.match((llm.calls.at(-1)!.payload as { instructions: string }).instructions, /Ask ONE short follow-up question/);
    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.data, []);
  });

  it('answers general questions without tools and reports the skipped steps', async () => {
    const { agent } = makeAgent({ decide: () => routeAnswers({ purpose: 'general' }), stream: () => ['A KPI is a key performance indicator.'] });
    const { events, result } = await run(agent, 'What does KPI stand for?');
    assert.deepEqual(events.filter((e) => e.type === 'step.skipped').map((e) => (e as { step: string }).step), ['select_tools', 'search_documents']);
    assert.equal(result.answer, 'A KPI is a key performance indicator.');
  });

  it('documents-only questions still cite passages', async () => {
    const { agent } = makeAgent({ decide: () => routeAnswers({ purpose: 'business_documents', docs: 0.9 }), stream: () => ['Invoices are due in 30 days [D1].'] });
    const { result } = await run(agent, 'What are our payment terms?');
    assert.deepEqual(result.citations.map((c) => `${c.kind}:${c.source}`), ['document:policies/billing-terms.pdf']);
    assert.equal(result.answerTemplate, null);
  });

  it('emits run.failed and rejects when routing itself fails, and validates the question', async () => {
    const { agent } = makeAgent({ decide: () => Promise.reject(new Error('OpenAI API 401: bad key')) });
    const events: AgentEvent[] = [];
    await assert.rejects(agent.ask('Revenue?', (e) => events.push(e)), /401/);
    assert.deepEqual(eventTypes(events), ['run.started', 'step.started:route', 'step.failed:route', 'run.failed']);
    await assert.rejects(agent.ask('   ', () => {}), /empty/);
  });

  it('formats dates in the requested time zone', () => {
    assert.equal(formatDate(new Date('2026-10-25T03:30:00Z'), 'America/Chicago'), '2026-10-24');
    assert.equal(formatDate(new Date('2026-10-25T03:30:00Z'), 'UTC'), '2026-10-25');
  });
});
