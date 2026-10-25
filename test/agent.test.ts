import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Agent, formatDate, type AgentOptions } from '../src/agent/agent.ts';
import type { AgentEvent } from '../src/events.ts';
import type { DocumentSearch } from '../src/tools/documents/aiSearch.ts';
import { DatabaseService } from '../src/tools/database/service.ts';
import { eventTypes, exampleCatalog, FakeLlm, routeAnswers, tableChoice, type FakeLlmScript } from './helpers.ts';

const revenuePlan = {
  explanation: 'Revenue by month for 2026.',
  select: [
    { kind: 'column', column: 'invoice_date', aggregate: null, metric: null, timeGrain: 'month' },
    { kind: 'metric', column: null, aggregate: null, metric: 'revenue', timeGrain: null },
  ],
  filters: [{ column: 'invoice_date', operator: 'between', values: ['2026-01-01', '2026-12-31'] }],
  orderBy: [],
  limit: null,
};

const docs: DocumentSearch = {
  async search() {
    return [{ id: 'c1', source: 'policies/billing-terms.pdf', text: 'Invoices are due in 30 days.', score: 0.82, timestamp: null }];
  },
};

function makeAgent(script: FakeLlmScript, overrides: Partial<AgentOptions> = {}, rows: Record<string, unknown>[] = [{ invoice_date_month: '2026-01-01', revenue: '12400.00' }]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const database = new DatabaseService(exampleCatalog(), {
    timeoutMs: 1000,
    env: { SALES_DATABASE_URL: 'postgres://test', SUPPORT_DATABASE_URL: 'mssql://test' },
    factory: async () => ({
      async query(sql, params) {
        queries.push({ sql, params });
        return rows;
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
    maxRows: 200,
    showSql: true,
    predicateThreshold: 0.5,
    clarifyThreshold: 0.7,
    tableConfidenceWarning: 0.6,
    now: () => new Date('2026-10-24T15:00:00Z'),
    ...overrides,
  });
  return { agent, llm, queries };
}

async function run(agent: Agent, question: string) {
  const events: AgentEvent[] = [];
  const result = await agent.ask(question, (e) => events.push(e));
  return { result, events };
}

describe('Agent', () => {
  it('routes, queries the database and searches documents in parallel, then streams a cited answer', async () => {
    const { agent, llm, queries } = makeAgent({
      decide: (_input, questions) => (questions[0]!.name === 'table' ? tableChoice('sales.v_invoices') : routeAnswers({ purpose: 'data_and_documents', db: 0.9, docs: 0.8 })),
      structured: () => revenuePlan,
      stream: () => ['Revenue in January was $12,400 [T1]. ', 'Invoices are due in 30 days [D1].'],
    });
    const { result, events } = await run(agent, 'What was revenue by month this year, and when are invoices due?');

    const types = eventTypes(events);
    assert.equal(types[0], 'run.started');
    assert.equal(types.at(-1), 'run.completed');
    for (const step of ['route', 'select_table', 'build_query', 'run_query', 'search_documents', 'write_answer']) {
      assert.ok(types.includes(`step.completed:${step}`), `missing ${step} in ${types.join(', ')}`);
    }
    assert.ok(types.indexOf('step.completed:route') < types.indexOf('step.started:select_table'));
    assert.ok(types.indexOf('step.completed:run_query') < types.indexOf('step.started:write_answer'));

    const build = events.find((e) => e.type === 'step.completed' && e.step === 'build_query') as Extract<AgentEvent, { type: 'step.completed' }>;
    assert.match(String(build.data.sql), /date_trunc\('month', "invoice_date"\)/);
    assert.deepEqual(queries[0]!.params, ['2026-01-01', '2026-12-31']);

    const deltas = events.filter((e) => e.type === 'answer.delta').map((e) => (e as { text: string }).text);
    assert.deepEqual(deltas, ['Revenue in January was $12,400 [T1]. ', 'Invoices are due in 30 days [D1].']);
    assert.deepEqual(result.citations.map((c) => `${c.id}:${c.source}`), ['T1:sales.v_invoices', 'D1:policies/billing-terms.pdf']);

    const answerCall = llm.calls.find((c) => c.kind === 'stream')!.payload as { instructions: string; input: string };
    assert.match(answerCall.instructions, /Today is 2026-10-24/);
    assert.match(answerCall.input, /\[T1\] Database result from sales.v_invoices/);
    assert.match(answerCall.input, /"revenue":"12400.00"/);
    assert.match(answerCall.input, /\[D1\] Document: policies\/billing-terms.pdf/);
  });

  it('gives the planner today\'s date in the configured time zone and the table description', async () => {
    const { agent, llm } = makeAgent({
      decide: (_i, q) => (q[0]!.name === 'table' ? tableChoice('sales.v_invoices') : routeAnswers({ purpose: 'business_data', db: 0.9 })),
      structured: () => revenuePlan,
    });
    await run(agent, 'Revenue by month this year?');
    const plan = llm.calls.find((c) => c.kind === 'structured')!.payload as { instructions: string; schemaName: string };
    assert.equal(plan.schemaName, 'query_plan');
    assert.match(plan.instructions, /Today is 2026-10-24 \(America\/Chicago\)/);
    assert.match(plan.instructions, /- customer_name \(string\): Customer's business name\. Example values: "Northwind Traders"/);
    assert.match(plan.instructions, /- revenue: Invoiced revenue/);
  });

  it('retries the query plan once with the validation problems, then succeeds', async () => {
    const { agent, llm } = makeAgent({
      decide: (_i, q) => (q[0]!.name === 'table' ? tableChoice('sales.v_invoices') : routeAnswers({ purpose: 'business_data', db: 0.9 })),
      structured: (_req, call) => (call === 1 ? { ...revenuePlan, select: [{ kind: 'aggregate', column: 'customer_name', aggregate: 'sum', metric: null, timeGrain: null }] } : revenuePlan),
    });
    const { events } = await run(agent, 'Revenue by month?');
    const second = llm.calls.filter((c) => c.kind === 'structured')[1]!.payload as { input: string };
    assert.match(second.input, /previous plan was rejected:\n- select\[0\]: sum needs a numeric column/);
    const build = events.find((e) => e.type === 'step.completed' && e.step === 'build_query') as Extract<AgentEvent, { type: 'step.completed' }>;
    assert.equal(build.data.attempts, 2);
  });

  it('keeps going when one tool fails and tells the answer step what is missing', async () => {
    const { agent, llm } = makeAgent(
      {
        decide: (_i, q) => (q[0]!.name === 'table' ? tableChoice('sales.v_invoices') : routeAnswers({ purpose: 'data_and_documents' })),
        structured: () => revenuePlan,
      },
      { documents: { search: async () => Promise.reject(new Error('AI Search request failed (503)')) } },
    );
    const { events, result } = await run(agent, 'Revenue and payment terms?');
    assert.ok(eventTypes(events).includes('step.failed:search_documents'));
    assert.equal(eventTypes(events).at(-1), 'run.completed');
    const answer = llm.calls.find((c) => c.kind === 'stream')!.payload as { instructions: string };
    assert.match(answer.instructions, /document search failed \(AI Search request failed \(503\)\)/);
    assert.equal(result.citations[0]!.id, 'T1');
  });

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
  });

  it('answers general questions without tools and reports the skipped steps', async () => {
    const { agent } = makeAgent({ decide: () => routeAnswers({ purpose: 'general' }), stream: () => ['A KPI is a key performance indicator.'] });
    const { events } = await run(agent, 'What does KPI stand for?');
    const skipped = events.filter((e) => e.type === 'step.skipped').map((e) => (e as { step: string }).step);
    assert.deepEqual(skipped, ['select_table', 'search_documents']);
  });

  it('skips the query when the decision model picks "none", and selects directly when there is only one table', async () => {
    const none = makeAgent({
      decide: (_i, q) => (q[0]!.name === 'table' ? tableChoice('none', 0.7) : routeAnswers({ purpose: 'business_data', db: 0.9 })),
    });
    const { events } = await run(none.agent, 'How many employees do we have?');
    assert.ok(!eventTypes(events).includes('step.started:build_query'));
    assert.match((none.llm.calls.at(-1)!.payload as { input: string }).input, /no table or view in the catalog holds the data/);

    const catalog = exampleCatalog();
    catalog.sources = [{ ...catalog.sources[0]!, tables: [catalog.sources[0]!.tables[0]!] }];
    const single = makeAgent({ decide: () => routeAnswers({ purpose: 'business_data', db: 0.9 }), structured: () => revenuePlan }, {
      database: new DatabaseService(catalog, { timeoutMs: 1000, env: { SALES_DATABASE_URL: 'x' }, factory: async () => ({ query: async () => [], close: async () => {} }) }),
    });
    const r = await run(single.agent, 'Revenue?');
    const select = r.events.find((e) => e.type === 'step.completed' && e.step === 'select_table') as Extract<AgentEvent, { type: 'step.completed' }>;
    assert.equal(select.data.method, 'only_table');
    assert.equal(single.llm.calls.filter((c) => c.kind === 'decide').length, 1);
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
