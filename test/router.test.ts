import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideRoute, routeQuestion, type RouterOptions } from '../src/agent/router.ts';
import { FakeLlm, routeAnswers } from './helpers.ts';

const options: RouterOptions = {
  databaseAvailable: true,
  documentsAvailable: true,
  databaseDescription: 'billing',
  documentsDescription: 'policies',
  predicateThreshold: 0.5,
  clarifyThreshold: 0.7,
};

describe('routing', () => {
  it('asks the decision model one choice and three predicates, with the available sources in the input', async () => {
    const llm = new FakeLlm({ decide: () => routeAnswers({ purpose: 'business_data', db: 0.9 }) });
    const route = await routeQuestion(llm, 'Revenue last month?', options);
    const payload = llm.calls[0]!.payload as { input: string; questions: Array<{ type: string; name: string }> };
    assert.match(payload.input, /Question: Revenue last month\?/);
    assert.match(payload.input, /Business database: billing/);
    assert.deepEqual(payload.questions.map((q) => `${q.type}:${q.name}`), ['choice:purpose', 'predicate:needs_database', 'predicate:needs_documents', 'predicate:is_ambiguous']);
    assert.equal(route.useDatabase, true);
    assert.equal(route.useDocuments, false);
  });

  it('uses both tools when either the purpose or the predicates call for them', () => {
    const route = decideRoute(routeAnswers({ purpose: 'business_documents', db: 0.6 }), options);
    assert.equal(route.useDatabase, true);
    assert.equal(route.useDocuments, true);
    const both = decideRoute(routeAnswers({ purpose: 'data_and_documents' }), options);
    assert.equal(both.useDatabase && both.useDocuments, true);
  });

  it('asks a follow-up instead of using tools when the question is ambiguous', () => {
    const route = decideRoute(routeAnswers({ purpose: 'business_data', db: 0.9, ambiguous: 0.8 }), options);
    assert.equal(route.clarify, true);
    assert.equal(route.useDatabase, false);
    assert.equal(decideRoute(routeAnswers({ purpose: 'unclear', confidence: 0.6 }), options).clarify, true);
    assert.equal(decideRoute(routeAnswers({ purpose: 'unclear', confidence: 0.3 }), options).clarify, false);
  });

  it('flags tools that are needed but not configured', () => {
    const route = decideRoute(routeAnswers({ purpose: 'data_and_documents' }), { ...options, documentsAvailable: false });
    assert.deepEqual(route.unavailable, ['documents']);
    assert.equal(route.useDocuments, false);
    assert.equal(route.useDatabase, true);
  });

  it('treats a refused or unknown purpose as "other" and uses no tools for general questions', () => {
    const route = decideRoute([{ type: 'refusal', name: 'purpose' }], options);
    assert.equal(route.purpose, 'other');
    assert.equal(route.useDatabase || route.useDocuments || route.clarify, false);
  });
});
