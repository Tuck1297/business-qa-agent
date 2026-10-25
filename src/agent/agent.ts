/**
 * The orchestrator. One question in, a stream of step events out:
 *
 *   route (Decisions API)
 *     ├─ database:  select_table (Decisions API) → build_query (Responses, structured) → run_query
 *     └─ documents: search_documents (Cloudflare AI Search)          ← runs in parallel
 *   write_answer (Responses, streamed token by token)
 *
 * A failing tool doesn't fail the run: its step reports the error and the answer says what's missing.
 */

import { randomUUID } from 'node:crypto';
import { errorMessage, runStep, type Citation, type EventSink } from '../events.ts';
import type { LlmClient } from '../llm/types.ts';
import type { DocumentChunk, DocumentSearch } from '../tools/documents/aiSearch.ts';
import type { DatabaseService } from '../tools/database/service.ts';
import { runDatabaseTool, type DatabaseToolResult } from '../tools/database/tool.ts';
import { buildAnswerPrompt, usedCitations, type AnswerMode } from './answer.ts';
import { routeQuestion, type RouteDecision } from './router.ts';

export interface AgentOptions {
  llm: LlmClient;
  database: DatabaseService | null;
  documents: DocumentSearch | null;
  documentsDescription: string;
  timezone: string;
  maxRows: number;
  showSql: boolean;
  predicateThreshold: number;
  clarifyThreshold: number;
  tableConfidenceWarning: number;
  /** Override "today" in tests. */
  now?: () => Date;
}

export interface AgentResult {
  runId: string;
  answer: string;
  citations: Citation[];
}

export const MAX_QUESTION_LENGTH = 2_000;

export class Agent {
  private readonly options: AgentOptions;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  async ask(questionRaw: string, emit: EventSink, signal?: AbortSignal): Promise<AgentResult> {
    const o = this.options;
    const runId = randomUUID();
    const started = Date.now();
    const question = questionRaw.trim();
    emit({ type: 'run.started', runId, question, at: new Date(started).toISOString() });

    try {
      if (!question) throw new Error('The question is empty.');
      if (question.length > MAX_QUESTION_LENGTH) throw new Error(`The question is longer than ${MAX_QUESTION_LENGTH} characters.`);
      const today = formatDate(o.now?.() ?? new Date(), o.timezone);

      const route = await runStep(
        emit,
        runId,
        'route',
        'Working out what the question needs',
        () =>
          routeQuestion(
            o.llm,
            question,
            {
              databaseAvailable: o.database !== null,
              documentsAvailable: o.documents !== null,
              databaseDescription: describeDatabase(o.database),
              documentsDescription: o.documentsDescription,
              predicateThreshold: o.predicateThreshold,
              clarifyThreshold: o.clarifyThreshold,
            },
            signal,
          ),
        summarizeRoute,
      );

      const notes: string[] = route.unavailable.map((tool) =>
        tool === 'database'
          ? 'this question needs the business database, but no database is configured, so the answer may be incomplete.'
          : 'this question needs business documents, but document search is not configured, so the answer may be incomplete.',
      );

      let database: DatabaseToolResult | null = null;
      let documents: DocumentChunk[] | null = null;

      if (!route.clarify) {
        if (!route.useDatabase) emit({ type: 'step.skipped', runId, step: 'select_table', reason: skipReason(route, 'database'), at: now() });
        if (!route.useDocuments) emit({ type: 'step.skipped', runId, step: 'search_documents', reason: skipReason(route, 'documents'), at: now() });

        const [dbOutcome, docOutcome] = await Promise.allSettled([
          route.useDatabase && o.database
            ? runDatabaseTool({
                llm: o.llm,
                db: o.database,
                emit,
                runId,
                question,
                today,
                timezone: o.timezone,
                maxRows: o.maxRows,
                showSql: o.showSql,
                tableConfidenceWarning: o.tableConfidenceWarning,
                ...(signal ? { signal } : {}),
              })
            : Promise.resolve(null),
          route.useDocuments && o.documents
            ? runStep(
                emit,
                runId,
                'search_documents',
                'Searching business documents',
                () => o.documents!.search(question, signal),
                (chunks) => ({
                  count: chunks.length,
                  topScore: chunks[0] ? Math.round(chunks[0].score * 1000) / 1000 : null,
                  sources: [...new Set(chunks.map((c) => c.source))].slice(0, 5),
                }),
              )
            : Promise.resolve(null),
        ]);

        if (dbOutcome.status === 'fulfilled') database = dbOutcome.value;
        else notes.push(`the database lookup failed (${errorMessage(dbOutcome.reason)}), so database figures are missing.`);
        if (docOutcome.status === 'fulfilled') documents = docOutcome.value;
        else notes.push(`the document search failed (${errorMessage(docOutcome.reason)}), so document information is missing.`);
      }

      const mode: AnswerMode = route.clarify
        ? 'clarify'
        : route.useDatabase || route.useDocuments || route.unavailable.length > 0
          ? 'grounded'
          : 'general';
      const prompt = buildAnswerPrompt(mode, { question, today, database, documents, notes });

      const answer = await runStep(
        emit,
        runId,
        'write_answer',
        mode === 'clarify' ? 'Asking a follow-up question' : 'Writing the answer',
        () =>
          o.llm.streamText({
            instructions: prompt.instructions,
            input: prompt.input,
            onDelta: (text) => emit({ type: 'answer.delta', runId, text }),
            ...(signal ? { signal } : {}),
          }),
        (text) => ({ mode, characters: text.length }),
      );

      const citations = usedCitations(answer, prompt.citations);
      emit({ type: 'run.completed', runId, answer, citations, durationMs: Date.now() - started, at: now() });
      return { runId, answer, citations };
    } catch (error) {
      emit({ type: 'run.failed', runId, error: errorMessage(error), durationMs: Date.now() - started, at: now() });
      throw error;
    }
  }
}

function summarizeRoute(r: RouteDecision): Record<string, unknown> {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    purpose: r.purpose,
    purposeConfidence: round(r.purposeConfidence),
    useDatabase: r.useDatabase,
    useDocuments: r.useDocuments,
    clarify: r.clarify,
    unavailable: r.unavailable,
    probabilities: { needsDatabase: round(r.needsDatabase), needsDocuments: round(r.needsDocuments), isAmbiguous: round(r.isAmbiguous) },
  };
}

function skipReason(route: RouteDecision, tool: 'database' | 'documents'): string {
  if (route.unavailable.includes(tool)) return `Needed, but ${tool === 'database' ? 'no database' : 'no document search'} is configured.`;
  return `The question doesn't need the ${tool === 'database' ? 'database' : 'documents'}.`;
}

function describeDatabase(db: DatabaseService | null): string {
  if (!db) return 'not available';
  return db.catalog.sources
    .map((s) => `${s.description ?? s.name} (tables: ${s.tables.map((t) => t.name).join(', ')})`)
    .join('; ')
    .slice(0, 1_500);
}

/** YYYY-MM-DD in the given IANA time zone. */
export function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function now(): string {
  return new Date().toISOString();
}
