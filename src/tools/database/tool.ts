/**
 * The database route. Your tools are the only path to the database:
 *
 *   select_tools     OpenAI Decisions API, one predicate per tool ("would this tool return data
 *                    the question needs?"), so the model only sees a short list of relevant tools
 *   plan_tool_calls  OpenAI function calling over the short list: the model picks calls and fills
 *                    in their parameters. It never writes SQL.
 *   run_tool         your SQL with the validated arguments bound, read-only, row-capped
 *
 * The rows stay in this process. The model later sees only call ids, arguments and field
 * descriptions, and writes merge fields that the service fills in.
 */

import { errorMessage, runStep, type EventSink } from '../../events.ts';
import type { DecisionAnswer, FunctionCall, LlmClient } from '../../llm/types.ts';
import { ArgumentError, toFunctionTool, validateArguments, type ArgValue } from './arguments.ts';
import { findTool, type DbTool } from './definitions.ts';
import type { DatabaseService, QueryResult } from './service.ts';

export interface DatabaseToolsContext {
  llm: LlmClient;
  db: DatabaseService;
  emit: EventSink;
  runId: string;
  question: string;
  today: string;
  timezone: string;
  /** A tool is offered to the model when its Decisions probability is at least this. */
  selectThreshold: number;
  maxCalls: number;
  showSql: boolean;
  signal?: AbortSignal;
}

export interface ToolCallResult {
  /** Merge-field id: the tool name, then tool_2, tool_3 for repeat calls. */
  id: string;
  tool: DbTool;
  args: Record<string, ArgValue>;
  status: 'ok' | 'failed';
  result: QueryResult | null;
  error: string | null;
}

export interface DatabaseRouteResult {
  /** 'no_tool' when no defined tool fits the question. */
  status: 'ok' | 'no_tool';
  calls: ToolCallResult[];
}

/** Most tools offered to the model at once; OpenAI suggests staying under 20 functions. */
export const MAX_SHORTLIST = 8;

export async function runDatabaseTools(ctx: DatabaseToolsContext): Promise<DatabaseRouteResult> {
  const shortlist = await runStep(
    ctx.emit,
    ctx.runId,
    'select_tools',
    'Choosing database tools',
    () => selectTools(ctx),
    (s) => ({
      considered: ctx.db.tools.tools.length,
      selected: s.map((x) => ({ tool: x.tool.name, probability: round(x.probability) })),
    }),
  );
  if (shortlist.length === 0) return { status: 'no_tool', calls: [] };

  const planned = await runStep(
    ctx.emit,
    ctx.runId,
    'plan_tool_calls',
    'Filling in tool parameters',
    () => planCalls(ctx, shortlist.map((s) => s.tool)),
    (p) => ({ attempts: p.attempts, calls: p.calls.map((c) => ({ id: c.id, tool: c.tool.name, arguments: c.args })), dropped: p.dropped }),
  );
  if (planned.calls.length === 0) return { status: 'no_tool', calls: [] };

  const calls = await Promise.all(
    planned.calls.map(async (call): Promise<ToolCallResult> => {
      try {
        const result = await runStep(
          ctx.emit,
          ctx.runId,
          'run_tool',
          `Running ${call.id}`,
          () => ctx.db.run(call.tool, call.args),
          (r) => ({
            id: call.id,
            tool: call.tool.name,
            arguments: call.args,
            rowCount: r.rows.length,
            truncated: r.truncated,
            ...(ctx.showSql ? (({ sql, params }) => ({ sql, params }))(ctx.db.prepare(call.tool, call.args)) : {}),
          }),
          `run_tool:${call.id}`,
        );
        return { ...call, status: 'ok', result, error: null };
      } catch (error) {
        return { ...call, status: 'failed', result: null, error: errorMessage(error) };
      }
    }),
  );
  return { status: 'ok', calls };
}

async function selectTools(ctx: DatabaseToolsContext): Promise<Array<{ tool: DbTool; probability: number }>> {
  const tools = ctx.db.tools.tools;
  const answers = await ctx.llm.decide(
    `Question: ${ctx.question}\nToday: ${ctx.today} (${ctx.timezone})`,
    tools.map((tool) => ({
      type: 'predicate' as const,
      name: tool.name,
      instructions: `Calling the "${tool.name}" tool would return data needed to answer the question. What the tool does: ${tool.description.trim()}`,
    })),
    ctx.signal,
  );
  return rankShortlist(tools, answers, ctx.selectThreshold);
}

export function rankShortlist(tools: DbTool[], answers: DecisionAnswer[], threshold: number): Array<{ tool: DbTool; probability: number }> {
  const probability = new Map(answers.flatMap((a) => (a.type === 'predicate' ? [[a.name, a.probability] as const] : [])));
  return tools
    .map((tool) => ({ tool, probability: probability.get(tool.name) ?? 0 }))
    .filter((t) => t.probability >= threshold)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, MAX_SHORTLIST);
}

interface PlannedCall {
  id: string;
  tool: DbTool;
  args: Record<string, ArgValue>;
}

async function planCalls(ctx: DatabaseToolsContext, tools: DbTool[]): Promise<{ calls: PlannedCall[]; attempts: number; dropped: number }> {
  const instructions = [
    'You choose which database tools to call to answer a business question, and fill in their parameters.',
    `Today is ${ctx.today} (${ctx.timezone}). Turn relative dates such as "last month", "this year" or "Q3" into explicit dates based on today.`,
    "Use null for optional parameters the question doesn't specify.",
    `Call a tool more than once only when the question needs it (for example to compare two periods). At most ${ctx.maxCalls} calls in total.`,
    "You won't see the results; another step writes the answer.",
  ].join('\n');
  let input = ctx.question;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await ctx.llm.callTools({ instructions, input, tools: tools.map(toFunctionTool), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    try {
      const { calls, dropped } = resolveCalls(raw, tools, ctx.maxCalls);
      return { calls, attempts: attempt, dropped };
    } catch (error) {
      if (!(error instanceof ArgumentError) || attempt === 2) throw error;
      // One retry with the exact problems.
      input = `${ctx.question}\n\nYour previous tool call was rejected: ${error.message}\nCall the tools again with corrected arguments.`;
    }
  }
  throw new Error('Unreachable');
}

/** Check names, parse and validate arguments, cap the count, and assign merge-field ids. */
export function resolveCalls(raw: FunctionCall[], allowed: DbTool[], maxCalls: number): { calls: PlannedCall[]; dropped: number } {
  const calls: PlannedCall[] = [];
  const seen = new Map<string, number>();
  for (const call of raw.slice(0, maxCalls)) {
    const tool = findTool({ sources: [], tools: allowed }, call.name);
    if (!tool) throw new ArgumentError(call.name, [`"${call.name}" isn't one of the offered tools.`]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      throw new ArgumentError(tool.name, ['Arguments must be valid JSON.']);
    }
    const args = validateArguments(tool, parsed);
    const n = (seen.get(tool.name) ?? 0) + 1;
    seen.set(tool.name, n);
    calls.push({ id: n === 1 ? tool.name : `${tool.name}_${n}`, tool, args });
  }
  return { calls, dropped: Math.max(0, raw.length - maxCalls) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
