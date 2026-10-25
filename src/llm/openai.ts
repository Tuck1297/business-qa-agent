/**
 * Minimal OpenAI client over fetch (no SDK dependency).
 *
 * - Decisions API  (POST /v1/decisions)  — routing and tool selection.
 * - Responses API  (POST /v1/responses)  — function calling (tool arguments) and streamed answers.
 *
 * Responses calls send `store: false` so prompts containing business data aren't kept
 * as stored responses on OpenAI's side. The Decisions API doesn't accept `store`.
 */

import {
  ModelRefusalError,
  type DecisionAnswer,
  type DecisionQuestion,
  type FunctionCall,
  type LlmClient,
  type TextStreamRequest,
  type ToolCallRequest,
} from './types.ts';

export interface OpenAiOptions {
  apiKey: string;
  baseUrl: string;
  decisionModel: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class OpenAiClient implements LlmClient {
  private readonly options: OpenAiOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async decide(input: string, questions: DecisionQuestion[], signal?: AbortSignal): Promise<DecisionAnswer[]> {
    const body = await this.postJson('/decisions', { model: this.options.decisionModel, input, questions }, signal);
    return parseDecisionAnswers(body);
  }

  async callTools(request: ToolCallRequest): Promise<FunctionCall[]> {
    const body = await this.postJson(
      '/responses',
      {
        model: this.options.model,
        instructions: request.instructions,
        input: request.input,
        store: false,
        tools: request.tools,
        tool_choice: 'required',
        parallel_tool_calls: true,
      },
      request.signal,
    );
    return extractFunctionCalls(body);
  }

  async streamText(request: TextStreamRequest): Promise<string> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/responses`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.options.model,
        instructions: request.instructions,
        input: request.input,
        store: false,
        stream: true,
      }),
      signal: this.signal(request.signal),
    });
    if (!response.ok || !response.body) throw await httpError(response);

    let full = '';
    let refusal = '';
    let finished = false;
    for await (const event of readServerSentEvents(response.body)) {
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        full += event.delta;
        request.onDelta(event.delta);
      } else if (type === 'response.refusal.delta' && typeof event.delta === 'string') {
        refusal += event.delta;
      } else if (type === 'response.completed') {
        finished = true;
      } else if (type === 'response.incomplete') {
        const reason = readPath(event, ['response', 'incomplete_details', 'reason']);
        throw new Error(`The answer was cut off (${typeof reason === 'string' ? reason : 'incomplete'}).`);
      } else if (type === 'response.failed') {
        const message = readPath(event, ['response', 'error', 'message']);
        throw new Error(`OpenAI response failed: ${typeof message === 'string' ? message : 'unknown error'}`);
      } else if (type === 'error') {
        const message = event.message ?? readPath(event, ['error', 'message']);
        throw new Error(`OpenAI stream error: ${typeof message === 'string' ? message : 'unknown error'}`);
      }
    }
    if (refusal && !full) throw new ModelRefusalError(refusal);
    if (!finished) throw new Error('The OpenAI stream ended before the response completed.');
    return full;
  }

  private async postJson(path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: this.signal(signal),
    });
    if (!response.ok) throw await httpError(response);
    return response.json();
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' };
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
}

/** Validate and normalize the `answers` array of a Decisions API response. */
export function parseDecisionAnswers(body: unknown): DecisionAnswer[] {
  const answers = readPath(body, ['answers']);
  if (!Array.isArray(answers)) throw new Error('Decisions API response has no answers array.');
  return answers.map((raw, index): DecisionAnswer => {
    const type = readPath(raw, ['type']);
    const nameValue = readPath(raw, ['name']);
    const name = typeof nameValue === 'string' ? nameValue : null;
    if (type === 'refusal') return { type: 'refusal', name };
    if (name === null) throw new Error(`Decisions answer ${index} has no name.`);
    if (type === 'predicate') {
      const probability = readPath(raw, ['probability']);
      if (typeof probability !== 'number') throw new Error(`Predicate answer "${name}" has no probability.`);
      return { type: 'predicate', name, probability };
    }
    if (type === 'choice') {
      const choice = readPath(raw, ['choice']);
      const confidence = readPath(raw, ['confidence']);
      const probabilities = readPath(raw, ['probabilities']);
      if (typeof choice !== 'string' && typeof choice !== 'boolean') {
        throw new Error(`Choice answer "${name}" has no choice.`);
      }
      return {
        type: 'choice',
        name,
        choice: String(choice),
        confidence: typeof confidence === 'number' ? confidence : 0,
        probabilities: Array.isArray(probabilities)
          ? probabilities
              .map((p) => ({
                value: String(readPath(p, ['value'])),
                probability: Number(readPath(p, ['probability'])),
              }))
              .filter((p) => Number.isFinite(p.probability))
          : [],
      };
    }
    throw new Error(`Unsupported Decisions answer type "${String(type)}" for "${name}".`);
  });
}

/** Function calls from a Responses API result (arguments stay JSON strings; callers validate them). */
export function extractFunctionCalls(body: unknown): FunctionCall[] {
  const status = readPath(body, ['status']);
  if (status === 'incomplete') {
    const reason = readPath(body, ['incomplete_details', 'reason']);
    throw new Error(`The model's output was cut off (${typeof reason === 'string' ? reason : 'incomplete'}).`);
  }
  if (status === 'failed') {
    const message = readPath(body, ['error', 'message']);
    throw new Error(`OpenAI response failed: ${typeof message === 'string' ? message : 'unknown error'}`);
  }
  const output = readPath(body, ['output']);
  if (!Array.isArray(output)) throw new Error('Responses API result has no output array.');
  const calls: FunctionCall[] = [];
  for (const item of output) {
    const type = readPath(item, ['type']);
    if (type === 'function_call') {
      const name = readPath(item, ['name']);
      const args = readPath(item, ['arguments']);
      const callId = readPath(item, ['call_id']) ?? readPath(item, ['id']);
      if (typeof name !== 'string') continue;
      calls.push({
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        callId: String(callId ?? `call_${calls.length + 1}`),
      });
    } else if (type === 'message') {
      const content = readPath(item, ['content']);
      const refusal = Array.isArray(content) ? content.find((c) => readPath(c, ['type']) === 'refusal') : undefined;
      if (refusal) {
        const text = readPath(refusal, ['refusal']);
        throw new ModelRefusalError(typeof text === 'string' ? text : 'The model refused.');
      }
    }
  }
  return calls;
}

/** Parse a server-sent-events body into JSON payloads (ignores comments and [DONE]). */
export async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
      }
      if (done) {
        const parsed = parseSseBlock(buffer);
        if (parsed) yield parsed;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): Record<string, unknown> | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function httpError(response: Response): Promise<Error> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const parsed: unknown = JSON.parse(text);
      const message = readPath(parsed, ['error', 'message']);
      detail = typeof message === 'string' ? message : text;
    } catch {
      detail = text;
    }
  } catch {
    detail = '';
  }
  return new Error(`OpenAI API ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
}

export function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
