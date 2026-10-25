/** Shared fixtures and fakes for tests. */

import { readFileSync } from 'node:fs';
import type { AgentEvent } from '../src/events.ts';
import type { DecisionAnswer, DecisionQuestion, LlmClient, StructuredRequest, TextStreamRequest } from '../src/llm/types.ts';
import { validateCatalog, type Catalog } from '../src/tools/database/catalog.ts';

export function exampleCatalog(): Catalog {
  const text = readFileSync(new URL('../catalog.example.json', import.meta.url), 'utf8');
  return validateCatalog(JSON.parse(text));
}

export interface FakeLlmScript {
  decide?: (input: string, questions: DecisionQuestion[]) => DecisionAnswer[] | Promise<DecisionAnswer[]>;
  structured?: (request: StructuredRequest, call: number) => unknown;
  stream?: (request: TextStreamRequest) => string[] | Promise<string[]>;
}

/** A scripted LlmClient that records every call. */
export class FakeLlm implements LlmClient {
  readonly calls: Array<{ kind: 'decide' | 'structured' | 'stream'; payload: unknown }> = [];
  private readonly script: FakeLlmScript;
  private structuredCount = 0;

  constructor(script: FakeLlmScript) {
    this.script = script;
  }

  async decide(input: string, questions: DecisionQuestion[]): Promise<DecisionAnswer[]> {
    this.calls.push({ kind: 'decide', payload: { input, questions } });
    if (!this.script.decide) throw new Error('decide not scripted');
    return this.script.decide(input, questions);
  }

  async structured(request: StructuredRequest): Promise<unknown> {
    this.calls.push({ kind: 'structured', payload: request });
    if (!this.script.structured) throw new Error('structured not scripted');
    this.structuredCount += 1;
    return this.script.structured(request, this.structuredCount);
  }

  async streamText(request: TextStreamRequest): Promise<string> {
    this.calls.push({ kind: 'stream', payload: request });
    const parts = this.script.stream ? await this.script.stream(request) : ['ok'];
    for (const part of parts) request.onDelta(part);
    return parts.join('');
  }
}

/** Route answers: which predicates fire and the purpose. */
export function routeAnswers(opts: {
  purpose: string;
  db?: number;
  docs?: number;
  ambiguous?: number;
  confidence?: number;
}): DecisionAnswer[] {
  return [
    { type: 'choice', name: 'purpose', choice: opts.purpose, confidence: opts.confidence ?? 0.9, probabilities: [] },
    { type: 'predicate', name: 'needs_database', probability: opts.db ?? 0 },
    { type: 'predicate', name: 'needs_documents', probability: opts.docs ?? 0 },
    { type: 'predicate', name: 'is_ambiguous', probability: opts.ambiguous ?? 0 },
  ];
}

export function tableChoice(table: string, confidence = 0.92): DecisionAnswer[] {
  return [
    {
      type: 'choice',
      name: 'table',
      choice: table,
      confidence,
      probabilities: [
        { value: table, probability: confidence },
        { value: 'none', probability: 1 - confidence },
      ],
    },
  ];
}

export function eventTypes(events: AgentEvent[]): string[] {
  return events
    .filter((e) => e.type !== 'answer.delta')
    .map((e) => ('step' in e ? `${e.type}:${e.step}` : e.type));
}

/** Build a Response whose body streams the given string pieces. */
export function streamingResponse(pieces: string[], init: ResponseInit = { status: 200 }): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' }, ...init });
}
