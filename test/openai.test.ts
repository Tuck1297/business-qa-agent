import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractOutputText, OpenAiClient, parseDecisionAnswers } from '../src/llm/openai.ts';
import { ModelRefusalError } from '../src/llm/types.ts';
import { streamingResponse } from './helpers.ts';

type Captured = { url: string; init: RequestInit };

function client(respond: (captured: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const c = new OpenAiClient({
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.test/v1',
    decisionModel: 'gpt-6-luna',
    model: 'gpt-6-astra',
    timeoutMs: 5_000,
    fetch: async (url, init) => {
      const captured = { url: String(url), init: init ?? {} };
      calls.push(captured);
      return respond(captured);
    },
  });
  return { c, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Decisions API', () => {
  it('posts model, input and questions to /decisions and parses typed answers', async () => {
    const { c, calls } = client(() =>
      json({
        model: 'gpt-6-luna',
        answers: [
          { type: 'choice', name: 'purpose', choice: 'business_data', probabilities: [{ value: 'business_data', probability: 0.8 }], confidence: 0.8 },
          { type: 'predicate', name: 'needs_database', probability: 0.93 },
          { type: 'refusal', name: 'is_ambiguous' },
        ],
      }),
    );
    const answers = await c.decide('How much did we invoice?', [{ type: 'predicate', name: 'needs_database', instructions: 'x' }]);
    assert.equal(calls[0]!.url, 'https://api.example.test/v1/decisions');
    const sent = JSON.parse(String(calls[0]!.init.body));
    assert.equal(sent.model, 'gpt-6-luna');
    assert.equal(sent.input, 'How much did we invoice?');
    assert.equal(sent.questions.length, 1);
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
    assert.deepEqual(answers[1], { type: 'predicate', name: 'needs_database', probability: 0.93 });
    assert.deepEqual(answers[2], { type: 'refusal', name: 'is_ambiguous' });
    assert.equal(answers[0]!.type === 'choice' && answers[0]!.choice, 'business_data');
  });

  it('turns boolean choices into strings and rejects malformed answers', () => {
    const [a] = parseDecisionAnswers({ answers: [{ type: 'choice', name: 'flag', choice: true, confidence: 0.6 }] });
    assert.equal(a!.type === 'choice' && a!.choice, 'true');
    assert.throws(() => parseDecisionAnswers({}), /no answers array/);
    assert.throws(() => parseDecisionAnswers({ answers: [{ type: 'predicate', name: 'x' }] }), /no probability/);
    assert.throws(() => parseDecisionAnswers({ answers: [{ type: 'score', name: 'x' }] }), /Unsupported/);
  });

  it('surfaces API error messages', async () => {
    const { c } = client(() => json({ error: { message: 'Invalid model' } }, 400));
    await assert.rejects(c.decide('q', []), /OpenAI API 400: Invalid model/);
  });
});

describe('Responses API — structured', () => {
  it('sends a strict json_schema format with store:false and parses the JSON text', async () => {
    const { c, calls } = client(() =>
      json({ status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }] }),
    );
    const result = await c.structured({ instructions: 'sys', input: 'q', schemaName: 'plan', schema: { type: 'object' } });
    assert.deepEqual(result, { a: 1 });
    const sent = JSON.parse(String(calls[0]!.init.body));
    assert.equal(calls[0]!.url, 'https://api.example.test/v1/responses');
    assert.equal(sent.store, false);
    assert.deepEqual(sent.text.format, { type: 'json_schema', name: 'plan', schema: { type: 'object' }, strict: true });
  });

  it('raises refusals, cut-offs and failures', () => {
    assert.throws(
      () => extractOutputText({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] }),
      (e: Error) => e instanceof ModelRefusalError && e.message === 'No.',
    );
    assert.throws(() => extractOutputText({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), /cut off \(max_output_tokens\)/);
    assert.throws(() => extractOutputText({ status: 'failed', error: { message: 'boom' } }), /boom/);
    assert.throws(() => extractOutputText({ output: [] }), /no output text/);
  });
});

describe('Responses API — streaming', () => {
  it('emits text deltas as they arrive, even when SSE events split across network chunks', async () => {
    const events = [
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'Revenue ' },
      { type: 'response.output_text.delta', delta: 'was $12,400 [T1].' },
      { type: 'response.completed' },
    ];
    const wire = events.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('');
    const pieces = [wire.slice(0, 17), wire.slice(17, 90), wire.slice(90)];
    const { c, calls } = client(() => streamingResponse(pieces));
    const deltas: string[] = [];
    const text = await c.streamText({ instructions: 'sys', input: 'q', onDelta: (d) => deltas.push(d) });
    assert.equal(text, 'Revenue was $12,400 [T1].');
    assert.deepEqual(deltas, ['Revenue ', 'was $12,400 [T1].']);
    const sent = JSON.parse(String(calls[0]!.init.body));
    assert.equal(sent.stream, true);
    assert.equal(sent.store, false);
  });

  it('fails on error events, failed responses, refusals and early stream end', async () => {
    const sse = (...events: object[]) => streamingResponse([events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')]);
    await assert.rejects(client(() => sse({ type: 'error', message: 'rate limited' })).c.streamText({ instructions: '', input: '', onDelta() {} }), /rate limited/);
    await assert.rejects(
      client(() => sse({ type: 'response.failed', response: { error: { message: 'server error' } } })).c.streamText({ instructions: '', input: '', onDelta() {} }),
      /server error/,
    );
    await assert.rejects(
      client(() => sse({ type: 'response.refusal.delta', delta: 'I can\'t help.' }, { type: 'response.completed' })).c.streamText({ instructions: '', input: '', onDelta() {} }),
      ModelRefusalError,
    );
    await assert.rejects(
      client(() => sse({ type: 'response.output_text.delta', delta: 'half' })).c.streamText({ instructions: '', input: '', onDelta() {} }),
      /ended before the response completed/,
    );
  });
});
