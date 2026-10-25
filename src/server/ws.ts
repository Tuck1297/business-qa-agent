/**
 * WebSocket streaming on /ws, using the `ws` package.
 *
 * Protocol (JSON text messages):
 *   client → { "type": "auth", "token": "..." }               first, when API_TOKEN is set (browsers can't send headers)
 *   server → { "type": "ready" }
 *   client → { "type": "ask", "question": "...", "requestId": "optional id" }
 *   server → every agent event, with requestId added, ending in run.completed or run.failed
 *   client → { "type": "cancel" }                              stops the question in progress
 *   server → { "type": "error", "error": "..." }               for protocol mistakes
 *
 * One question at a time per connection; open more connections for parallel questions.
 */

import type { Server } from 'node:http';
import { errorMessage } from '../events.ts';
import { MAX_QUESTION_LENGTH } from '../agent/agent.ts';
import { tokensMatch, type AskHandler } from './http.ts';

// The parts of `ws` used here, declared locally so the core doesn't depend on @types/ws.
interface WsSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
export interface WsServer {
  readonly clients: Set<{ terminate(): void }>;
  on(event: 'connection', listener: (socket: WsSocket) => void): unknown;
  close(callback?: () => void): void;
}
interface WsModule {
  WebSocketServer: new (options: { server: Server; path: string; maxPayload: number }) => WsServer;
}

const OPEN = 1;
const AUTH_TIMEOUT_MS = 10_000;

export async function attachWebSocket(
  server: Server,
  agent: AskHandler,
  apiToken: string | null,
): Promise<WsServer | null> {
  let mod: WsModule;
  try {
    const imported = (await import('ws')) as unknown as { default?: WsModule } & WsModule;
    mod = imported.WebSocketServer ? imported : (imported.default ?? imported);
  } catch {
    console.warn(
      '[ws] The "ws" package isn\'t installed, so WebSocket streaming is off. SSE on POST /ask/stream still works.',
    );
    return null;
  }

  const wss = new mod.WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('connection', (socket) => handleConnection(socket, agent, apiToken));
  return wss;
}

/** Stop accepting connections and drop open ones (closing the server alone leaves them open). */
export function closeWebSocket(wss: WsServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  return new Promise((resolve) => wss.close(() => resolve()));
}

export function handleConnection(socket: WsSocket, agent: AskHandler, apiToken: string | null): void {
  let authorized = apiToken === null;
  let current: AbortController | null = null;
  const send = (message: unknown) => {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
  };

  const authTimer = authorized
    ? null
    : setTimeout(() => {
        send({ type: 'error', error: 'Send {"type":"auth","token":"..."} first.' });
        socket.close(4401, 'Unauthorized');
      }, AUTH_TIMEOUT_MS);
  if (authorized) send({ type: 'ready' });

  socket.on('message', (data, isBinary) => {
    if (isBinary) return send({ type: 'error', error: 'Send JSON text messages.' });
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(data));
      if (!parsed || typeof parsed !== 'object') throw new Error();
      message = parsed as Record<string, unknown>;
    } catch {
      return send({ type: 'error', error: 'Messages must be JSON objects.' });
    }

    if (message.type === 'auth') {
      if (authorized) return send({ type: 'ready' });
      if (typeof message.token === 'string' && apiToken !== null && tokensMatch(message.token, apiToken)) {
        authorized = true;
        if (authTimer) clearTimeout(authTimer);
        return send({ type: 'ready' });
      }
      send({ type: 'error', error: 'Wrong token.' });
      return socket.close(4401, 'Unauthorized');
    }
    if (!authorized) {
      send({ type: 'error', error: 'Authenticate first.' });
      return socket.close(4401, 'Unauthorized');
    }

    if (message.type === 'cancel') {
      current?.abort(new Error('Cancelled by the client.'));
      return;
    }
    if (message.type !== 'ask')
      return send({ type: 'error', error: `Unknown message type "${String(message.type)}".` });
    if (current)
      return send({
        type: 'error',
        error: 'A question is already running on this connection. Cancel it or open another connection.',
      });

    const question = typeof message.question === 'string' ? message.question : '';
    const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 100) : null;
    if (question.trim() === '' || question.length > MAX_QUESTION_LENGTH) {
      return send({ type: 'error', requestId, error: `"question" must be 1 to ${MAX_QUESTION_LENGTH} characters.` });
    }

    const controller = new AbortController();
    current = controller;
    agent
      .ask(question, (event) => send({ ...event, requestId }), controller.signal)
      .catch(() => undefined) // run.failed was already sent
      .finally(() => {
        if (current === controller) current = null;
      });
  });

  socket.on('close', () => {
    if (authTimer) clearTimeout(authTimer);
    current?.abort(new Error('Client disconnected.'));
  });
  socket.on('error', (error) => console.error('[ws] socket error:', errorMessage(error)));
}
