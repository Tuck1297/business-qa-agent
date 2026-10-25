import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AgentResult } from '../src/agent/agent.ts';
import type { AgentEvent, EventSink } from '../src/events.ts';
import { createHttpServer, isAuthorized, type AskHandler } from '../src/server/http.ts';
import { attachWebSocket, closeWebSocket, type WsServer } from '../src/server/ws.ts';

const TOKEN = 'test-token-123';

/** A fake agent that emits a realistic event sequence, slowly enough to cancel. */
class ScriptedAgent implements AskHandler {
  aborted = 0;
  async ask(question: string, emit: EventSink, signal?: AbortSignal): Promise<AgentResult> {
    const runId = 'run-1';
    const at = new Date().toISOString();
    emit({ type: 'run.started', runId, question, at });
    emit({ type: 'step.started', runId, step: 'route', key: 'route', label: 'Routing', at });
    emit({
      type: 'step.completed',
      runId,
      step: 'route',
      key: 'route',
      label: 'Routing',
      durationMs: 1,
      data: { purpose: 'business_data' },
      at,
    });
    if (question.includes('slow')) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          this.aborted += 1;
          reject(new Error('aborted'));
        });
      }).catch((error) => {
        emit({ type: 'run.failed', runId, error: String(error), durationMs: 1, at });
        throw error;
      });
    }
    if (question.includes('fail')) {
      emit({ type: 'run.failed', runId, error: 'boom', durationMs: 1, at });
      throw new Error('boom');
    }
    emit({ type: 'answer.delta', runId, text: 'Hello ' });
    emit({ type: 'answer.delta', runId, text: 'world' });
    const result = { runId, answer: 'Hello world', answerTemplate: null, citations: [], data: [], merge: null };
    emit({ type: 'run.completed', ...result, durationMs: 2, at });
    return result;
  }
}

let server: Server;
let wss: WsServer | null;
let base: string;
const agent = new ScriptedAgent();

before(async () => {
  server = createHttpServer({
    agent,
    apiToken: TOKEN,
    status: { database: true, documents: false },
    indexHtmlPath: null,
  });
  wss = await attachWebSocket(server, agent, TOKEN);
  assert.ok(wss, 'the ws package should be installed for these tests');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (wss) await closeWebSocket(wss);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (path: string, body: unknown, token: string | null = TOKEN) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('HTTP API', () => {
  it('reports health without auth', async () => {
    const res = await fetch(`${base}/health`);
    assert.deepEqual(await res.json(), { ok: true, database: true, documents: false });
  });

  it('requires the bearer token', async () => {
    assert.equal((await post('/ask', { question: 'hi' }, null)).status, 401);
    assert.equal((await post('/ask', { question: 'hi' }, 'wrong')).status, 401);
    assert.equal(isAuthorized('Bearer test-token-123', TOKEN), true);
    assert.equal(isAuthorized('bearer test-token-123', TOKEN), true);
    assert.equal(isAuthorized(undefined, null), true);
  });

  it('validates the body', async () => {
    assert.equal((await post('/ask', 'not json')).status, 400);
    assert.equal((await post('/ask', { question: '' })).status, 400);
    assert.equal((await post('/ask', { question: 'x'.repeat(2_001) })).status, 400);
    assert.equal((await post('/ask', { question: 'x', pad: 'y'.repeat(20_000) })).status, 400);
    assert.equal((await fetch(`${base}/ask`)).status, 405);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  it('POST /ask returns the answer and the step events (without token deltas)', async () => {
    const res = await post('/ask', { question: 'hi' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { answer: string; events: AgentEvent[] };
    assert.equal(body.answer, 'Hello world');
    assert.deepEqual(
      body.events.map((e) => e.type),
      ['run.started', 'step.started', 'step.completed', 'run.completed'],
    );
  });

  it('POST /ask returns 502 with the events when the run fails', async () => {
    const res = await post('/ask', { question: 'please fail' });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; events: AgentEvent[] };
    assert.equal(body.error, 'boom');
    assert.equal(body.events.at(-1)!.type, 'run.failed');
  });

  it('POST /ask/stream sends every event, including answer deltas, as server-sent events', async () => {
    const res = await post('/ask/stream', { question: 'hi' });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const text = await res.text();
    const events = text
      .split('\n\n')
      .filter((block) => block.startsWith('event:'))
      .map((block) => {
        const [eventLine, dataLine] = block.split('\n');
        const parsed = JSON.parse(dataLine!.slice('data: '.length)) as AgentEvent;
        assert.equal(eventLine, `event: ${parsed.type}`);
        return parsed;
      });
    assert.deepEqual(
      events.map((e) => e.type),
      ['run.started', 'step.started', 'step.completed', 'answer.delta', 'answer.delta', 'run.completed'],
    );
  });
});

describe('WebSocket /ws', () => {
  function connect(): Promise<{
    ws: WebSocket;
    messages: Array<Record<string, unknown>>;
    next: (type: string) => Promise<Record<string, unknown>>;
    closed: Promise<number>;
  }> {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      messages.push(message);
      const i = waiters.findIndex((w) => w.type === message.type);
      if (i !== -1) {
        (message as { _taken?: boolean })._taken = true;
        waiters.splice(i, 1)[0]!.resolve(message);
      }
    });
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
    const next = (type: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const seen = messages.find((m) => m.type === type && !(m as { _taken?: boolean })._taken);
        if (seen) {
          (seen as { _taken?: boolean })._taken = true;
          return resolve(seen);
        }
        waiters.push({ type, resolve });
      });
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve({ ws, messages, next, closed }));
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });
  }

  it('authenticates, then streams every event tagged with the requestId', async () => {
    const c = await connect();
    c.ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await c.next('ready');
    c.ws.send(JSON.stringify({ type: 'ask', question: 'hi', requestId: 'q1' }));
    const done = await c.next('run.completed');
    assert.equal(done.answer, 'Hello world');
    const runEvents = c.messages.filter((m) => m.requestId === 'q1').map((m) => m.type);
    assert.deepEqual(runEvents, [
      'run.started',
      'step.started',
      'step.completed',
      'answer.delta',
      'answer.delta',
      'run.completed',
    ]);
    c.ws.close();
  });

  it('closes the connection on a wrong token or a question before auth', async () => {
    const wrong = await connect();
    wrong.ws.send(JSON.stringify({ type: 'auth', token: 'nope' }));
    assert.equal(await wrong.closed, 4401);

    const early = await connect();
    early.ws.send(JSON.stringify({ type: 'ask', question: 'hi' }));
    assert.equal(await early.closed, 4401);
  });

  it('rejects a second question while one is running, and cancels on request', async () => {
    const c = await connect();
    c.ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await c.next('ready');
    c.ws.send(JSON.stringify({ type: 'ask', question: 'slow one', requestId: 'a' }));
    await c.next('step.completed');
    c.ws.send(JSON.stringify({ type: 'ask', question: 'another', requestId: 'b' }));
    const busy = await c.next('error');
    assert.match(String(busy.error), /already running/);
    const abortedBefore = agent.aborted;
    c.ws.send(JSON.stringify({ type: 'cancel' }));
    const failed = await c.next('run.failed');
    assert.equal(failed.requestId, 'a');
    assert.equal(agent.aborted, abortedBefore + 1);

    // The connection is free again.
    c.ws.send(JSON.stringify({ type: 'ask', question: 'hi', requestId: 'c' }));
    const done = await c.next('run.completed');
    assert.equal(done.requestId, 'c');
    c.ws.close();
  });

  it('reports protocol mistakes without closing', async () => {
    const c = await connect();
    c.ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await c.next('ready');
    c.ws.send('not json');
    assert.match(String((await c.next('error')).error), /JSON objects/);
    c.ws.send(JSON.stringify({ type: 'dance' }));
    assert.match(String((await c.next('error')).error), /Unknown message type/);
    c.ws.send(JSON.stringify({ type: 'ask', question: '' }));
    assert.match(String((await c.next('error')).error), /"question" must be/);
    c.ws.close();
  });
});
