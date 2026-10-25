/**
 * The orchestrator. One question in, a stream of step events out:
 *
 *   route (Decisions API)
 *     ├─ database:  select_tools (Decisions) → plan_tool_calls (function calling) → run_tool × N
 *     └─ documents: search_documents (Cloudflare AI Search)                ← runs in parallel
 *   write_answer (Responses, streamed) → merge fields filled in → answer.delta events
 *
 * Database rows never go to the model provider: the answer is written as a template and
 * the service fills in the values (src/merge) before any text reaches the client.
 * A failing tool doesn't fail the run: its step reports the error and the answer says what's missing.
 */

import { randomUUID } from 'node:crypto';
import { errorMessage, runStep, type Citation, type DataResult, type EventSink } from '../events.ts';
import type { LlmClient } from '../llm/types.ts';
import {
  emptyReport,
  renderTemplate,
  StreamingMerger,
  tidy,
  truncationNote,
  type MergeOptions,
  type MergeReport,
  type MergeSource,
} from '../merge/merge.ts';
import type { DocumentChunk, DocumentSearch } from '../tools/documents/aiSearch.ts';
import type { DatabaseService } from '../tools/database/service.ts';
import { runDatabaseTools, type DatabaseRouteResult } from '../tools/database/tool.ts';
import { buildAnswerPrompt, usedCitations, type AnswerMode } from './answer.ts';
import { routeQuestion, type RouteDecision } from './router.ts';

export interface AgentOptions {
  llm: LlmClient;
  database: DatabaseService | null;
  documents: DocumentSearch | null;
  documentsDescription: string;
  timezone: string;
  locale: string;
  currency: string;
  showSql: boolean;
  maxToolCalls: number;
  toolSelectThreshold: number;
  predicateThreshold: number;
  clarifyThreshold: number;
  /** Override "today" in tests. */
  now?: () => Date;
}

export interface AgentResult {
  runId: string;
  answer: string;
  answerTemplate: string | null;
  citations: Citation[];
  data: DataResult[];
  merge: MergeReport | null;
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
      if (question.length > MAX_QUESTION_LENGTH)
        throw new Error(`The question is longer than ${MAX_QUESTION_LENGTH} characters.`);
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
          ? 'this question needs the business database, but no database tools are configured, so the answer may be incomplete.'
          : 'this question needs business documents, but document search is not configured, so the answer may be incomplete.',
      );

      let database: DatabaseRouteResult | null = null;
      let documents: DocumentChunk[] | null = null;

      if (!route.clarify) {
        if (!route.useDatabase)
          emit({
            type: 'step.skipped',
            runId,
            step: 'select_tools',
            key: 'select_tools',
            reason: skipReason(route, 'database'),
            at: now(),
          });
        if (!route.useDocuments)
          emit({
            type: 'step.skipped',
            runId,
            step: 'search_documents',
            key: 'search_documents',
            reason: skipReason(route, 'documents'),
            at: now(),
          });

        const [dbOutcome, docOutcome] = await Promise.allSettled([
          route.useDatabase && o.database
            ? runDatabaseTools({
                llm: o.llm,
                db: o.database,
                emit,
                runId,
                question,
                today,
                timezone: o.timezone,
                selectThreshold: o.toolSelectThreshold,
                maxCalls: o.maxToolCalls,
                showSql: o.showSql,
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

        // Notes go to the model, so database failures are described without their error text.
        if (dbOutcome.status === 'fulfilled') database = dbOutcome.value;
        else notes.push('the database lookup failed, so database figures are missing.');
        if (docOutcome.status === 'fulfilled') documents = docOutcome.value;
        else
          notes.push(
            `the document search failed (${errorMessage(docOutcome.reason)}), so document information is missing.`,
          );
      }

      const mode: AnswerMode = route.clarify
        ? 'clarify'
        : route.useDatabase || route.useDocuments || route.unavailable.length > 0
          ? 'grounded'
          : 'general';
      const prompt = buildAnswerPrompt(mode, { question, today, database, documents, notes });
      const sources = mergeSources(database);
      const mergeOptions: MergeOptions = { locale: o.locale, currency: o.currency, timeZone: o.timezone };
      const merger = new StreamingMerger(sources, mergeOptions);

      const template = await runStep(
        emit,
        runId,
        'write_answer',
        mode === 'clarify' ? 'Asking a follow-up question' : 'Writing the answer',
        async () => {
          const text = await o.llm.streamText({
            instructions: prompt.instructions,
            input: prompt.input,
            onDelta: (delta) => {
              const merged = merger.push(delta);
              if (merged) emit({ type: 'answer.delta', runId, text: merged });
            },
            ...(signal ? { signal } : {}),
          });
          const rest = merger.end();
          if (rest) emit({ type: 'answer.delta', runId, text: rest });
          return text;
        },
        (text) => ({
          mode,
          characters: text.length,
          mergeFields: merger.report.fields,
          unresolved: merger.report.unresolved.length,
        }),
      );

      // Re-render the complete template for the authoritative answer (tidier than the streamed pieces).
      const report = emptyReport();
      let answer = tidy(renderTemplate(template, sources, mergeOptions, report));
      const note = truncationNote(report, sources);
      if (note) {
        answer = `${answer}\n\n${note}`;
        emit({ type: 'answer.delta', runId, text: `\n\n${note}` });
      }

      const usesData = sources.length > 0;
      const result: AgentResult = {
        runId,
        answer,
        answerTemplate: usesData ? template : null,
        citations: usedCitations(template, prompt.citations, report.usedCalls),
        data: dataResults(database),
        merge: usesData ? report : null,
      };
      emit({ type: 'run.completed', ...result, durationMs: Date.now() - started, at: now() });
      return result;
    } catch (error) {
      emit({ type: 'run.failed', runId, error: errorMessage(error), durationMs: Date.now() - started, at: now() });
      throw error;
    }
  }
}

function mergeSources(database: DatabaseRouteResult | null): MergeSource[] {
  return (database?.calls ?? []).map((call) => ({
    id: call.id,
    tool: call.tool.name,
    fields: call.tool.output,
    status: call.status,
    rows: call.result?.rows ?? [],
    truncated: call.result?.truncated ?? false,
    rowLimit: call.result?.rowLimit ?? 0,
  }));
}

function dataResults(database: DatabaseRouteResult | null): DataResult[] {
  return (database?.calls ?? []).map((call) => ({
    id: call.id,
    tool: call.tool.name,
    arguments: call.args,
    status: call.status,
    error: call.error,
    fields: call.tool.output,
    rows: call.result?.rows ?? [],
    rowCount: call.result?.rows.length ?? 0,
    truncated: call.result?.truncated ?? false,
  }));
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
    probabilities: {
      needsDatabase: round(r.needsDatabase),
      needsDocuments: round(r.needsDocuments),
      isAmbiguous: round(r.isAmbiguous),
    },
  };
}

function skipReason(route: RouteDecision, tool: 'database' | 'documents'): string {
  if (route.unavailable.includes(tool))
    return `Needed, but ${tool === 'database' ? 'no database tools are' : 'no document search is'} configured.`;
  return `The question doesn't need the ${tool === 'database' ? 'database' : 'documents'}.`;
}

function describeDatabase(db: DatabaseService | null): string {
  if (!db) return 'not available';
  return `tools that look up ${db.tools.tools.map((t) => `${t.name} (${t.description.trim()})`).join('; ')}`.slice(
    0,
    1_500,
  );
}

/** YYYY-MM-DD in the given IANA time zone. */
export function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function now(): string {
  return new Date().toISOString();
}
