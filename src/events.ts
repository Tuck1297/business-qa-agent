/**
 * Events the agent emits while it works. Every transport (JSON, SSE, WebSocket)
 * sends exactly these objects, so a client written against one works with all.
 */

import type { MergeReport } from './merge/merge.ts';
import type { OutputField } from './tools/database/definitions.ts';

export type StepName = 'route' | 'select_tools' | 'plan_tool_calls' | 'run_tool' | 'search_documents' | 'write_answer';

export interface Citation {
  /** "D1", "D2"… for document passages; the call id (e.g. "revenue_by_month") for database data. */
  id: string;
  kind: 'document' | 'data';
  /** Document key (file path or URL), or the tool name. */
  source: string;
  /** Passage excerpt, or the arguments the tool ran with. */
  detail: string;
}

/** One database tool call's result, returned to the client (never sent to the model). */
export interface DataResult {
  id: string;
  tool: string;
  arguments: Record<string, string | number | boolean | null>;
  status: 'ok' | 'failed';
  error: string | null;
  fields: OutputField[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export type AgentEvent =
  | { type: 'run.started'; runId: string; question: string; at: string }
  /** `key` tells apart repeated steps, e.g. one run_tool per call ("run_tool:revenue_by_month"). */
  | { type: 'step.started'; runId: string; step: StepName; key: string; label: string; at: string }
  | {
      type: 'step.completed';
      runId: string;
      step: StepName;
      key: string;
      label: string;
      durationMs: number;
      data: Record<string, unknown>;
      at: string;
    }
  | { type: 'step.skipped'; runId: string; step: StepName; key: string; reason: string; at: string }
  | { type: 'step.failed'; runId: string; step: StepName; key: string; error: string; durationMs: number; at: string }
  /** Answer text with merge fields already filled in. */
  | { type: 'answer.delta'; runId: string; text: string }
  | {
      type: 'run.completed';
      runId: string;
      /** Final answer with merge fields filled in. Authoritative over the concatenated deltas. */
      answer: string;
      /** What the model wrote, with merge fields unfilled; null when no database data was used. */
      answerTemplate: string | null;
      citations: Citation[];
      /** Database results, for clients that want to render or reuse the rows. */
      data: DataResult[];
      merge: MergeReport | null;
      durationMs: number;
      at: string;
    }
  | { type: 'run.failed'; runId: string; error: string; durationMs: number; at: string };

export type EventSink = (event: AgentEvent) => void;

/** Run one step, emitting started/completed/failed around it. */
export async function runStep<T>(
  emit: EventSink,
  runId: string,
  step: StepName,
  label: string,
  fn: () => Promise<T>,
  summarize: (result: T) => Record<string, unknown>,
  key: string = step,
): Promise<T> {
  const started = Date.now();
  emit({ type: 'step.started', runId, step, key, label, at: new Date(started).toISOString() });
  try {
    const result = await fn();
    emit({
      type: 'step.completed',
      runId,
      step,
      key,
      label,
      durationMs: Date.now() - started,
      data: summarize(result),
      at: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    emit({
      type: 'step.failed',
      runId,
      step,
      key,
      error: errorMessage(error),
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    });
    throw error;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
