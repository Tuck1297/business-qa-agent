/**
 * HTTP API (node:http, no framework):
 *
 *   GET  /health        → { ok, database, documents }
 *   POST /ask           → { runId, answer, citations, events }       (waits for the whole run)
 *   POST /ask/stream    → text/event-stream, one SSE event per agent event as it happens
 *   GET  /              → the demo page in public/index.html
 *
 * WebSocket streaming on /ws is attached separately (see ws.ts).
 * All /ask routes need `Authorization: Bearer <API_TOKEN>` when API_TOKEN is set.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { errorMessage, type AgentEvent, type EventSink } from '../events.ts';
import { MAX_QUESTION_LENGTH, type AgentResult } from '../agent/agent.ts';

export interface AskHandler {
  ask(question: string, emit: EventSink, signal?: AbortSignal): Promise<AgentResult>;
}

export interface HttpServerOptions {
  agent: AskHandler;
  apiToken: string | null;
  status: { database: boolean; documents: boolean };
  /** Path to the demo page; null disables it. */
  indexHtmlPath: string | null;
}

const MAX_BODY_BYTES = 16 * 1024;
const HEARTBEAT_MS = 15_000;

export function createHttpServer(options: HttpServerOptions): Server {
  return createServer((req, res) => {
    handle(req, res, options).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, options: HttpServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, ...options.status });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!options.indexHtmlPath) return sendJson(res, 404, { error: 'Not found' });
    const html = await readFile(options.indexHtmlPath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end(html);
    return;
  }

  if (url.pathname === '/ask' || url.pathname === '/ask/stream') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' }, { Allow: 'POST' });
    if (!isAuthorized(req.headers.authorization, options.apiToken)) {
      return sendJson(res, 401, { error: 'Missing or wrong bearer token.' }, { 'WWW-Authenticate': 'Bearer' });
    }
    let question: string;
    try {
      question = parseQuestion(await readBody(req));
    } catch (error) {
      return sendJson(res, 400, { error: errorMessage(error) });
    }
    return url.pathname === '/ask' ? askJson(req, res, options.agent, question) : askStream(req, res, options.agent, question);
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function askJson(req: IncomingMessage, res: ServerResponse, agent: AskHandler, question: string): Promise<void> {
  const controller = abortOnDisconnect(req, res);
  const events: AgentEvent[] = [];
  try {
    const result = await agent.ask(question, (e) => events.push(e), controller.signal);
    sendJson(res, 200, { ...result, events: events.filter((e) => e.type !== 'answer.delta') });
  } catch (error) {
    sendJson(res, 502, { error: errorMessage(error), events: events.filter((e) => e.type !== 'answer.delta') });
  }
}

async function askStream(req: IncomingMessage, res: ServerResponse, agent: AskHandler, question: string): Promise<void> {
  const controller = abortOnDisconnect(req, res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // let nginx/Cloudflare pass events through unbuffered
  });
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
  const send: EventSink = (event) => {
    if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  try {
    await agent.ask(question, send, controller.signal);
  } catch {
    // The agent already emitted run.failed; nothing else to send.
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

function abortOnDisconnect(req: IncomingMessage, res: ServerResponse): AbortController {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new Error('Client disconnected.'));
  });
  req.on('aborted', () => controller.abort(new Error('Client disconnected.')));
  return controller;
}

export function parseQuestion(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Send JSON like {"question": "..."}.');
  }
  const question = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).question : undefined;
  if (typeof question !== 'string' || question.trim() === '') throw new Error('"question" must be a non-empty string.');
  if (question.length > MAX_QUESTION_LENGTH) throw new Error(`"question" must be at most ${MAX_QUESTION_LENGTH} characters.`);
  return question;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error(`Request body is larger than ${MAX_BODY_BYTES} bytes.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Constant-time bearer-token check. With no API_TOKEN configured, everything is allowed (loopback only; see config). */
export function isAuthorized(header: string | undefined, apiToken: string | null): boolean {
  if (!apiToken) return true;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1] !== undefined && tokensMatch(match[1].trim(), apiToken);
}

export function tokensMatch(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}
