/**
 * Final step: the prompt for writing the answer.
 *
 * Database results are NOT in the prompt. The model gets each call's id, the tool's
 * description, the arguments it ran with, and the output fields' names and descriptions,
 * and writes merge fields where values belong (see src/merge/merge.ts). Document passages
 * from AI Search are included as text, as before.
 */

import type { Citation } from '../events.ts';
import type { DocumentChunk } from '../tools/documents/aiSearch.ts';
import type { DatabaseRouteResult, ToolCallResult } from '../tools/database/tool.ts';
import { toText } from '../text.ts';

export type AnswerMode = 'grounded' | 'clarify' | 'general';

export interface AnswerContext {
  question: string;
  today: string;
  database: DatabaseRouteResult | null;
  documents: DocumentChunk[] | null;
  /** Things that went wrong or were unavailable, so the answer can say so. Never contains database values. */
  notes: string[];
}

const MAX_CONTEXT_CHARS = 60_000;

export function buildAnswerPrompt(
  mode: AnswerMode,
  ctx: AnswerContext,
): { instructions: string; input: string; citations: Citation[] } {
  if (mode === 'clarify') {
    return {
      instructions: [
        'You help people get answers from their business data and documents.',
        "The user's question is too vague to answer well. Ask ONE short follow-up question that would let you answer it.",
        'Offer two or three concrete options when that helps (for example a time period or a measure). Do not answer the question yet.',
      ].join('\n'),
      input: ctx.question,
      citations: [],
    };
  }
  if (mode === 'general') {
    return {
      instructions: [
        'You help people with questions about their business.',
        "This question doesn't need the business database or documents. Answer it briefly from general knowledge,",
        "and don't invent facts about the user's own business.",
        ...ctx.notes.map((n) => `Note: ${n}`),
      ].join('\n'),
      input: ctx.question,
      citations: [],
    };
  }

  const citations: Citation[] = [];
  const sections: string[] = [];
  const calls = ctx.database?.calls ?? [];

  if (calls.length > 0) {
    sections.push(
      ['DATABASE DATA (values hidden; refer to them with merge fields)', ...calls.map(describeCall)].join('\n\n'),
    );
    for (const call of calls) {
      citations.push({ id: call.id, kind: 'data', source: call.tool.name, detail: formatArgs(call.args) });
    }
  } else if (ctx.database?.status === 'no_tool') {
    sections.push(
      'DATABASE: none of the defined database tools fits this question, so no database figures are available.',
    );
  }

  if (ctx.documents) {
    const docs =
      ctx.documents.length === 0 ? ['DOCUMENTS: the search found no matching passages.'] : ['DOCUMENT PASSAGES'];
    ctx.documents.forEach((chunk, i) => {
      const id = `D${i + 1}`;
      citations.push({ id, kind: 'document', source: chunk.source, detail: chunk.text.slice(0, 200) });
      docs.push(`[${id}] ${chunk.source}\n${chunk.text.trim()}`);
    });
    sections.push(docs.join('\n\n'));
  }

  let context = sections.join('\n\n---\n\n');
  if (context.length > MAX_CONTEXT_CHARS) context = `${context.slice(0, MAX_CONTEXT_CHARS)}\n…(context cut to fit)`;

  const rules = ['You answer business questions using ONLY the context below the question.', `Today is ${ctx.today}.`];
  if (calls.length > 0) {
    rules.push(
      '',
      'DATABASE VALUES ARE HIDDEN FROM YOU. The service fills them in after you write. Wherever a database value belongs, write a merge field instead:',
      '- {{call.field}}        the field in the first row                e.g. {{top_customers.customer_name}}',
      '- {{call[2].field}}     the field in row 2 (rows count from 1)',
      '- {{table call}}        every row as a table (put it on its own line)',
      '- {{count call}}        how many rows',
      '- {{list call.field}}   every value of a field as a list',
      '- {{sum call.field}}, {{avg call.field}}, {{min call.field}}, {{max call.field}}   computed over all rows',
      'Rules for database values:',
      '- Never write a database value yourself and never guess one. Use only the call ids and fields listed under DATABASE DATA.',
      '- Write sentences that stay true whatever the values turn out to be. Only say which row is highest, first or latest when the rows description says how rows are ordered.',
      '- Don\'t describe trends or compare values ("grew", "more than") because you can\'t see them. Present the values and let the reader compare.',
      '- When a call can return several rows, prefer {{table call}} or {{list call.field}} over picking single rows.',
      '- Results can be empty; the service then shows "—" or "No matching records", so don\'t promise that something exists.',
      "- Values are already formatted (currency, dates); don't add symbols or units around them.",
    );
  }
  if (ctx.documents && ctx.documents.length > 0) {
    rules.push('', 'Cite document passages inline right after the claim they support: [D1], [D2]…');
  }
  rules.push(
    '',
    "If the context doesn't contain what's needed, say so plainly and say what data or document would answer it. Never guess.",
    'Lead with the direct answer. Keep it concise. Use markdown.',
    ...ctx.notes.map((n) => `Tell the user: ${n}`),
  );

  return {
    instructions: rules.join('\n'),
    input: `Question: ${ctx.question}\n\nContext:\n\n${context || '(no context was found)'}`,
    citations,
  };
}

function describeCall(call: ToolCallResult): string {
  const header = `Call id: ${call.id}  (tool ${call.tool.name}: ${call.tool.description.trim()})`;
  const args = `Ran with: ${formatArgs(call.args) || 'no parameters'}`;
  if (call.status === 'failed')
    return `${header}\n${args}\nSTATUS: this data couldn't be retrieved. Don't use merge fields for "${call.id}"; tell the user it's unavailable.`;
  const rows = `Rows: ${call.tool.resultDescription?.trim() || 'as returned by the tool (order not specified).'}`;
  const fields = call.tool.output.map((f) => `- ${f.name} (${f.format ?? 'text'}): ${f.description.trim()}`);
  return [header, args, rows, 'Fields:', ...fields].join('\n');
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k} = ${v === null ? 'not set' : toText(v)}`)
    .join(', ');
}

/** Citations the answer actually used: documents by [D#] in the text, data calls by merge fields. */
export function usedCitations(template: string, citations: Citation[], usedCalls: string[]): Citation[] {
  return citations.filter((c) => (c.kind === 'document' ? template.includes(`[${c.id}]`) : usedCalls.includes(c.id)));
}
