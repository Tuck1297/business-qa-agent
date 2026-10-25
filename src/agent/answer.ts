/**
 * Final step: write the answer from what the tools found, with citations.
 */

import type { Citation } from '../events.ts';
import type { DocumentChunk } from '../tools/documents/aiSearch.ts';
import type { DatabaseToolResult } from '../tools/database/tool.ts';

export type AnswerMode = 'grounded' | 'clarify' | 'general';

export interface AnswerContext {
  question: string;
  today: string;
  database: DatabaseToolResult | null;
  documents: DocumentChunk[] | null;
  /** Things that went wrong or were unavailable, so the answer can say so. */
  notes: string[];
}

const MAX_CELL = 300;
const MAX_CONTEXT_CHARS = 60_000;

export function buildAnswerPrompt(mode: AnswerMode, ctx: AnswerContext): { instructions: string; input: string; citations: Citation[] } {
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

  if (ctx.database?.status === 'answered' && ctx.database.result) {
    const r = ctx.database.result;
    citations.push({ id: 'T1', kind: 'table', source: ctx.database.table ?? 'database', detail: ctx.database.explanation });
    const rows = r.rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clip(v)]))));
    sections.push(
      [
        `[T1] Database result from ${ctx.database.table}`,
        `What the query returns: ${ctx.database.explanation}`,
        `Columns: ${r.columns.join(', ')}`,
        `Rows: ${r.rows.length}${r.truncated ? ' (the table had more rows than this; the list is partial)' : ''}`,
        ...(rows.length ? rows : ['(no rows matched)']),
      ].join('\n'),
    );
  } else if (ctx.database?.status === 'no_table') {
    sections.push('Database: no table or view in the catalog holds the data for this question.');
  }

  if (ctx.documents) {
    if (ctx.documents.length === 0) sections.push('Documents: the search found no matching passages.');
    ctx.documents.forEach((chunk, i) => {
      const id = `D${i + 1}`;
      citations.push({ id, kind: 'document', source: chunk.source, detail: chunk.text.slice(0, 200) });
      sections.push(`[${id}] Document: ${chunk.source}\n${chunk.text.trim()}`);
    });
  }

  let context = sections.join('\n\n---\n\n');
  if (context.length > MAX_CONTEXT_CHARS) context = `${context.slice(0, MAX_CONTEXT_CHARS)}\n…(context cut to fit)`;

  const instructions = [
    'You answer business questions using ONLY the context provided below the question: database results and document passages.',
    `Today is ${ctx.today}.`,
    'Rules:',
    '- Cite sources inline right after the claim they support: [T1] for the database result, [D1], [D2]… for documents.',
    '- Report figures exactly as they appear. If you calculate something (a difference, a percentage), show the calculation.',
    "- If the context doesn't contain the answer, say so plainly and say what data or document would answer it. Never guess.",
    '- If the database result is partial, say the list is partial.',
    '- Lead with the direct answer. Use a short markdown table for several rows of figures. Keep it concise.',
    ...ctx.notes.map((n) => `- Tell the user: ${n}`),
  ].join('\n');

  return { instructions, input: `Question: ${ctx.question}\n\nContext:\n\n${context || '(no context was found)'}`, citations };
}

/** Keep only the citations the answer actually used; fall back to all of them. */
export function usedCitations(answer: string, citations: Citation[]): Citation[] {
  const used = citations.filter((c) => answer.includes(`[${c.id}]`));
  return used.length > 0 ? used : citations;
}

function clip(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_CELL) return `${value.slice(0, MAX_CELL)}…`;
  return value;
}
