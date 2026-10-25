/**
 * The database tool: pick a table or view (Decisions API), plan the query
 * (Responses API structured output, validated, one retry), then run it.
 */

import { runStep, type EventSink } from '../../events.ts';
import type { LlmClient } from '../../llm/types.ts';
import { describeTableForSelection, listTables, type TableRef } from './catalog.ts';
import { compileQuery, type CompiledQuery } from './compile.ts';
import type { DatabaseService, QueryResult } from './service.ts';
import { buildSpecSchema, SpecError, validateSpec, type QuerySpec } from './spec.ts';

export interface DatabaseToolContext {
  llm: LlmClient;
  db: DatabaseService;
  emit: EventSink;
  runId: string;
  question: string;
  today: string;
  timezone: string;
  maxRows: number;
  showSql: boolean;
  tableConfidenceWarning: number;
  signal?: AbortSignal;
}

export interface DatabaseToolResult {
  status: 'answered' | 'no_table';
  table: string | null;
  explanation: string;
  sql: string | null;
  params: unknown[];
  result: QueryResult | null;
}

/** The Decisions API accepts up to 255 choices; one is reserved for "none". */
export const MAX_SELECTABLE_TABLES = 254;
export const NO_TABLE = 'none';

export async function runDatabaseTool(ctx: DatabaseToolContext): Promise<DatabaseToolResult> {
  const tables = listTables(ctx.db.catalog);

  const selection = await runStep(
    ctx.emit,
    ctx.runId,
    'select_table',
    'Choosing a table or view',
    () => selectTable(ctx, tables),
    (s) => ({
      table: s.ref?.id ?? null,
      confidence: round(s.confidence),
      uncertain: s.ref !== null && s.confidence < ctx.tableConfidenceWarning,
      alternatives: s.alternatives,
      method: s.method,
    }),
  );
  if (!selection.ref) {
    return { status: 'no_table', table: null, explanation: 'No table or view in the catalog fits this question.', sql: null, params: [], result: null };
  }
  const ref = selection.ref;

  const planned = await runStep(
    ctx.emit,
    ctx.runId,
    'build_query',
    `Planning a query on ${ref.id}`,
    () => planQuery(ctx, ref),
    (p) => ({
      explanation: p.spec.explanation,
      attempts: p.attempts,
      ...(ctx.showSql ? { sql: p.compiled.sql, params: p.compiled.params } : {}),
    }),
  );

  const result = await runStep(
    ctx.emit,
    ctx.runId,
    'run_query',
    `Running the query on ${ref.source.name}`,
    () => ctx.db.run(ref.source, planned.compiled),
    (r) => ({ rowCount: r.rows.length, truncated: r.truncated, columns: r.columns }),
  );

  return {
    status: 'answered',
    table: ref.id,
    explanation: planned.spec.explanation,
    sql: planned.compiled.sql,
    params: planned.compiled.params,
    result,
  };
}

interface Selection {
  ref: TableRef | null;
  confidence: number;
  alternatives: Array<{ table: string; probability: number }>;
  method: 'only_table' | 'decisions_api';
}

async function selectTable(ctx: DatabaseToolContext, tables: TableRef[]): Promise<Selection> {
  if (tables.length === 1) {
    return { ref: tables[0] ?? null, confidence: 1, alternatives: [], method: 'only_table' };
  }
  if (tables.length > MAX_SELECTABLE_TABLES) {
    throw new Error(`The catalog lists ${tables.length} tables; table selection supports up to ${MAX_SELECTABLE_TABLES}. Split the catalog or pre-filter it.`);
  }
  const answers = await ctx.llm.decide(
    ctx.question,
    [
      {
        type: 'choice',
        name: 'table',
        instructions:
          'Which single table or view holds the data needed to answer this business question? Judge by what each one contains. Choose "none" if none of them can answer it.',
        choices: [
          ...tables.map((t) => ({ value: t.id, description: describeTableForSelection(t) })),
          { value: NO_TABLE, description: 'None of these tables or views holds the data this question needs.' },
        ],
      },
    ],
    ctx.signal,
  );
  const answer = answers.find((a) => a.name === 'table');
  if (!answer || answer.type === 'refusal') throw new Error('The decision model declined to choose a table.');
  if (answer.type !== 'choice') throw new Error('The decision model returned an unexpected answer type for table selection.');

  const alternatives = [...answer.probabilities]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3)
    .map((p) => ({ table: p.value, probability: round(p.probability) }));
  const ref = answer.choice === NO_TABLE ? null : (tables.find((t) => t.id === answer.choice) ?? null);
  if (answer.choice !== NO_TABLE && !ref) throw new Error(`The decision model chose an unknown table "${answer.choice}".`);
  return { ref, confidence: answer.confidence, alternatives, method: 'decisions_api' };
}

async function planQuery(
  ctx: DatabaseToolContext,
  ref: TableRef,
): Promise<{ spec: QuerySpec; compiled: CompiledQuery; attempts: number }> {
  const schema = buildSpecSchema(ref.table, ctx.maxRows);
  const instructions = buildPlannerInstructions(ref, ctx.today, ctx.timezone, ctx.maxRows);
  let input = ctx.question;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await ctx.llm.structured({ instructions, input, schemaName: 'query_plan', schema, signal: ctx.signal });
    try {
      const spec = validateSpec(raw, ref.table, ctx.maxRows);
      const compiled = compileQuery(spec, ref.table, ref.source.engine, ctx.maxRows);
      return { spec, compiled, attempts: attempt };
    } catch (error) {
      if (!(error instanceof SpecError) || attempt === 2) throw error;
      // One retry with the exact problems, the pattern that recovers most invalid plans.
      input = `${ctx.question}\n\nYour previous plan was rejected:\n- ${error.problems.join('\n- ')}\nReturn a corrected plan.`;
    }
  }
  throw new Error('Unreachable');
}

export function buildPlannerInstructions(ref: TableRef, today: string, timezone: string, maxRows: number): string {
  const t = ref.table;
  const lines = [
    'You turn a business question into a query plan for ONE table or view. You never write SQL; you fill in the plan structure.',
    `Today is ${today} (${timezone}). Turn relative dates such as "last month", "this year" or "Q3" into explicit YYYY-MM-DD ranges based on today.`,
    '',
    `Table: ${t.schema ? `${t.schema}.` : ''}${t.name} (${ref.source.engine})`,
    `What it holds: ${t.description}`,
    '',
    'Columns:',
    ...t.columns.map((c) => {
      const samples = c.sampleValues?.length ? ` Example values: ${c.sampleValues.slice(0, 8).map((v) => JSON.stringify(v)).join(', ')}.` : '';
      return `- ${c.name} (${c.type}): ${c.description}${samples}`;
    }),
  ];
  if (t.metrics?.length) {
    lines.push('', 'Metrics (predefined business calculations; prefer these over rebuilding them from columns):');
    lines.push(...t.metrics.map((m) => `- ${m.name}: ${m.description}`));
  }
  lines.push(
    '',
    'Rules:',
    '- Select only what the question needs. For totals, counts or averages use an aggregate or a metric; plain columns selected alongside them become the grouping.',
    '- For "by month", "per week" and similar, select the date column with a timeGrain.',
    '- For "top N" or "highest/lowest" questions, sort by the measured value and set limit to N.',
    '- When the exact stored text is uncertain (names, descriptions), filter with contains rather than eq.',
    `- Keep limit at or below ${maxRows}. Use null to get the default.`,
    "- If this table can't fully answer the question, return the closest useful plan and say what's missing in the explanation.",
  );
  return lines.join('\n');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
