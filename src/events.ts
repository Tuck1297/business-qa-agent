/**
 * Events the agent emits while it works. Every transport (JSON, SSE, WebSocket)
 * sends exactly these objects, so a client written against one works with all.
 */

export type StepName =
  | 'route'
  | 'select_table'
  | 'build_query'
  | 'run_query'
  | 'search_documents'
  | 'write_answer';

export interface Citation {
  /** Label used inside the answer text, e.g. "D1" or "T1". */
  id: string;
  kind: 'document' | 'table';
  /** Document key (file path or URL) or "source.table". */
  source: string;
  /** Document chunk text excerpt, or a short description of the query. */
  detail: string;
}

export type AgentEvent =
  | { type: 'run.started'; runId: string; question: string; at: string }
  | { type: 'step.started'; runId: string; step: StepName; label: string; at: string }
  | {
      type: 'step.completed';
      runId: string;
      step: StepName;
      label: string;
      durationMs: number;
      data: Record<string, unknown>;
      at: string;
    }
  | { type: 'step.skipped'; runId: string; step: StepName; reason: string; at: string }
  | { type: 'step.failed'; runId: string; step: StepName; error: string; durationMs: number; at: string }
  | { type: 'answer.delta'; runId: string; text: string }
  | {
      type: 'run.completed';
      runId: string;
      answer: string;
      citations: Citation[];
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
): Promise<T> {
  const started = Date.now();
  emit({ type: 'step.started', runId, step, label, at: new Date(started).toISOString() });
  try {
    const result = await fn();
    emit({
      type: 'step.completed',
      runId,
      step,
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
