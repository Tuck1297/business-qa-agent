/** Shared fixtures and fakes for tests. */

import { readFileSync } from 'node:fs';
import type { AgentEvent } from '../src/events.ts';
import type {
  DecisionAnswer,
  DecisionQuestion,
  FunctionCall,
  LlmClient,
  TextStreamRequest,
  ToolCallRequest,
} from '../src/llm/types.ts';
import { validateTools, type ToolSet } from '../src/tools/database/definitions.ts';

export function exampleTools(): ToolSet {
  const text = readFileSync(new URL('../tools.example.json', import.meta.url), 'utf8');
  return validateTools(JSON.parse(text));
}

export interface FakeLlmScript {
  decide?: (input: string, questions: DecisionQuestion[]) => DecisionAnswer[] | Promise<DecisionAnswer[]>;
  callTools?: (request: ToolCallRequest, call: number) => FunctionCall[] | Promise<FunctionCall[]>;
  stream?: (request: TextStreamRequest) => string[] | Promise<string[]>;
}

/** A scripted LlmClient that records every request it receives. */
export class FakeLlm implements LlmClient {
  readonly calls: Array<{ kind: 'decide' | 'callTools' | 'stream'; payload: unknown }> = [];
  private readonly script: FakeLlmScript;
  private toolCallCount = 0;

  constructor(script: FakeLlmScript) {
    this.script = script;
  }

  async decide(input: string, questions: DecisionQuestion[]): Promise<DecisionAnswer[]> {
    this.calls.push({ kind: 'decide', payload: { input, questions } });
    if (!this.script.decide) throw new Error('decide not scripted');
    return this.script.decide(input, questions);
  }

  async callTools(request: ToolCallRequest): Promise<FunctionCall[]> {
    this.calls.push({
      kind: 'callTools',
      payload: { instructions: request.instructions, input: request.input, tools: request.tools },
    });
    if (!this.script.callTools) throw new Error('callTools not scripted');
    this.toolCallCount += 1;
    return this.script.callTools(request, this.toolCallCount);
  }

  async streamText(request: TextStreamRequest): Promise<string> {
    this.calls.push({ kind: 'stream', payload: { instructions: request.instructions, input: request.input } });
    const parts = this.script.stream ? await this.script.stream(request) : ['ok'];
    for (const part of parts) request.onDelta(part);
    return parts.join('');
  }

  /** Everything this fake was sent, as one string, for "did this value leak?" checks. */
  everythingSent(): string {
    return JSON.stringify(this.calls);
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

/** Tool-selection answers: one predicate per tool question, using the given probabilities (others 0.02). */
export function toolPredicates(questions: DecisionQuestion[], probabilities: Record<string, number>): DecisionAnswer[] {
  return questions.map((q) => ({ type: 'predicate', name: q.name, probability: probabilities[q.name] ?? 0.02 }));
}

/** Decide handler that answers routing and tool selection. */
export function decider(route: Parameters<typeof routeAnswers>[0], tools: Record<string, number>) {
  return (_input: string, questions: DecisionQuestion[]) =>
    questions[0]!.name === 'purpose' ? routeAnswers(route) : toolPredicates(questions, tools);
}

export function call(name: string, args: Record<string, unknown>, id = `call_${name}`): FunctionCall {
  return { callId: id, name, arguments: JSON.stringify(args) };
}

export function eventTypes(events: AgentEvent[]): string[] {
  return events.filter((e) => e.type !== 'answer.delta').map((e) => ('key' in e ? `${e.type}:${e.key}` : e.type));
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
