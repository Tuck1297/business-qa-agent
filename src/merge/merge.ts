/**
 * Merge fields: how database values reach the answer WITHOUT going to the model.
 *
 * The model writes the answer as a template, knowing only each tool call's id, its
 * arguments and its output field names and descriptions. The service then fills in:
 *
 *   {{call.field}}         the field in the first row          {{top_unpaid_customers.customer_name}}
 *   {{call[2].field}}      the field in row 2 (1-based)        {{top_unpaid_customers[2].customer_name}}
 *   {{table call}}         all rows as a markdown table        {{table revenue_by_month}}
 *   {{count call}}         number of rows                      {{count overdue_invoices}}
 *   {{list call.field}}    every value, as a list              {{list overdue_invoices.invoice_number}}
 *   {{sum call.field}}     sum / avg / min / max over rows     {{sum revenue_by_month.revenue}}
 *
 * Values are formatted by the field's `format` (currency, percent, date, month…).
 * Unknown or failed references render as "[unavailable]" and are listed in the report.
 */

import type { FieldFormat, OutputField } from '../tools/database/definitions.ts';

export interface MergeSource {
  /** Call id used in merge fields: the tool name, or tool_2, tool_3 for repeat calls. */
  id: string;
  tool: string;
  fields: OutputField[];
  status: 'ok' | 'failed';
  rows: Record<string, unknown>[];
  truncated: boolean;
  rowLimit: number;
}

export interface MergeOptions {
  locale: string;
  currency: string;
  timeZone: string;
}

export interface MergeReport {
  /** Number of merge fields filled or attempted. */
  fields: number;
  /** Merge fields that couldn't be filled, with why. */
  unresolved: Array<{ field: string; reason: string }>;
  /** Calls referenced in the answer. */
  usedCalls: string[];
  /** Referenced calls that returned no rows. */
  emptyCalls: string[];
  /** Referenced calls whose rows were cut off at the row cap. */
  truncatedCalls: string[];
}

export const UNAVAILABLE = '[unavailable]';
export const EMPTY_VALUE = '—';
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const ID = '([a-z][a-z0-9_]*)';
const FIELD = '([A-Za-z_][A-Za-z0-9_]*)';
const WHOLE = new RegExp(`^(table|count)\\s+${ID}$`);
const AGG = new RegExp(`^(list|sum|avg|min|max)\\s+${ID}\\.${FIELD}$`);
const CELL = new RegExp(`^${ID}(?:\\[(\\d+)\\])?\\.${FIELD}$`);

export function emptyReport(): MergeReport {
  return { fields: 0, unresolved: [], usedCalls: [], emptyCalls: [], truncatedCalls: [] };
}

/** Fill every merge field in a complete template. */
export function renderTemplate(
  template: string,
  sources: MergeSource[],
  options: MergeOptions,
  report = emptyReport(),
): string {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return template.replace(TOKEN, (whole, expr: string) => {
    report.fields += 1;
    return renderField(expr, byId, options, report, whole);
  });
}

/** A note to append when any referenced result was cut off, or null. */
export function truncationNote(report: MergeReport, sources: MergeSource[]): string | null {
  if (report.truncatedCalls.length === 0) return null;
  const limits = [...new Set(sources.filter((s) => report.truncatedCalls.includes(s.id)).map((s) => s.rowLimit))];
  return `_Note: some results were cut off at the row limit (${limits.join('/')}), so lists, counts and totals may be incomplete._`;
}

/** Tidy the final text: no trailing spaces, no stray spaces around inserted tables, no runs of blank lines. */
export function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n\n {1,3}(?=\S)/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Streams merged text: holds back an unfinished "{{…" until it closes, so the client
 * never sees a raw merge field or half a value.
 */
export class StreamingMerger {
  private buffer = '';
  private readonly sources: MergeSource[];
  private readonly options: MergeOptions;
  readonly report = emptyReport();
  /** Longest text held back waiting for "}}" before it's treated as plain text. */
  private static readonly MAX_PENDING = 200;

  constructor(sources: MergeSource[], options: MergeOptions) {
    this.sources = sources;
    this.options = options;
  }

  push(delta: string): string {
    this.buffer += delta;
    let cut = this.buffer.length;
    const open = this.buffer.lastIndexOf('{{');
    if (open !== -1 && this.buffer.indexOf('}}', open) === -1) cut = open;
    else if (this.buffer.endsWith('{')) cut = this.buffer.length - 1;
    if (this.buffer.length - cut > StreamingMerger.MAX_PENDING) cut = this.buffer.length;
    const ready = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return ready ? renderTemplate(ready, this.sources, this.options, this.report) : '';
  }

  /** Flush whatever is left (an unclosed "{{" is passed through as text). */
  end(): string {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? renderTemplate(rest, this.sources, this.options, this.report) : '';
  }
}

function renderField(
  expr: string,
  byId: Map<string, MergeSource>,
  options: MergeOptions,
  report: MergeReport,
  whole: string,
): string {
  const fail = (reason: string) => {
    report.unresolved.push({ field: whole, reason });
    return UNAVAILABLE;
  };
  const use = (id: string): MergeSource | string => {
    const source = byId.get(id);
    if (!source) return `there's no data call "${id}"`;
    if (!report.usedCalls.includes(id)) report.usedCalls.push(id);
    if (source.status === 'failed') return `the "${id}" data couldn't be retrieved`;
    if (source.rows.length === 0 && !report.emptyCalls.includes(id)) report.emptyCalls.push(id);
    if (source.truncated && !report.truncatedCalls.includes(id)) report.truncatedCalls.push(id);
    return source;
  };
  const field = (source: MergeSource, name: string) => source.fields.find((f) => f.name === name);

  let m = WHOLE.exec(expr);
  if (m) {
    const source = use(m[2]!);
    if (typeof source === 'string') return fail(source);
    if (m[1] === 'count') return source.truncated ? `${source.rows.length}+` : String(source.rows.length);
    return `\n\n${markdownTable(source, options)}\n\n`;
  }

  m = AGG.exec(expr);
  if (m) {
    const source = use(m[2]!);
    if (typeof source === 'string') return fail(source);
    const f = field(source, m[3]!);
    if (!f) return fail(`"${m[2]}" has no field "${m[3]}"`);
    const values = source.rows.map((r) => r[f.name]).filter((v) => v !== null && v !== undefined);
    const format = f.format ?? 'text';
    switch (m[1]) {
      case 'list': {
        if (values.length === 0) return 'none';
        const items = values.map((v) => formatValue(v, format, options));
        return new Intl.ListFormat(options.locale, { type: 'conjunction' }).format(
          source.truncated ? [...items, 'more'] : items,
        );
      }
      case 'sum':
      case 'avg': {
        const nums = values.map(Number).filter(Number.isFinite);
        if (nums.length === 0) return EMPTY_VALUE;
        const total = nums.reduce((a, b) => a + b, 0);
        return formatValue(m[1] === 'sum' ? total : total / nums.length, format, options);
      }
      case 'min':
      case 'max': {
        if (values.length === 0) return EMPTY_VALUE;
        const numeric = values.every(
          (v) =>
            Number.isFinite(Number(v)) &&
            format !== 'date' &&
            format !== 'month' &&
            format !== 'datetime' &&
            format !== 'text',
        );
        const sorted = [...values].sort((a, b) =>
          numeric ? Number(a) - Number(b) : String(a).localeCompare(String(b)),
        );
        return formatValue(m[1] === 'min' ? sorted[0] : sorted[sorted.length - 1], format, options);
      }
    }
  }

  m = CELL.exec(expr);
  if (m) {
    const source = use(m[1]!);
    if (typeof source === 'string') return fail(source);
    const f = field(source, m[3]!);
    if (!f) return fail(`"${m[1]}" has no field "${m[3]}"`);
    const row = source.rows[m[2] ? Number(m[2]) - 1 : 0];
    if (!row) return EMPTY_VALUE;
    return formatValue(row[f.name], f.format ?? 'text', options);
  }

  return fail('not a recognized merge field');
}

export function markdownTable(source: MergeSource, options: MergeOptions): string {
  if (source.rows.length === 0) return '_No matching records._';
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const header = `| ${source.fields.map((f) => cell(f.label ?? f.name)).join(' | ')} |`;
  const divider = `| ${source.fields.map((f) => (isNumericFormat(f.format) ? '---:' : '---')).join(' | ')} |`;
  const body = source.rows.map(
    (row) => `| ${source.fields.map((f) => cell(formatValue(row[f.name], f.format ?? 'text', options))).join(' | ')} |`,
  );
  const lines = [header, divider, ...body];
  if (source.truncated) lines.push('', `_Showing the first ${source.rowLimit} rows._`);
  return lines.join('\n');
}

export function formatValue(value: unknown, format: FieldFormat, options: MergeOptions): string {
  if (value === null || value === undefined || value === '') return EMPTY_VALUE;
  const num =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  try {
    switch (format) {
      case 'currency':
        return Number.isFinite(num)
          ? new Intl.NumberFormat(options.locale, { style: 'currency', currency: options.currency }).format(num)
          : String(value);
      case 'percent':
        return Number.isFinite(num)
          ? new Intl.NumberFormat(options.locale, { style: 'percent', maximumFractionDigits: 1 }).format(num)
          : String(value);
      case 'number':
        return Number.isFinite(num)
          ? new Intl.NumberFormat(options.locale, { maximumFractionDigits: 2 }).format(num)
          : String(value);
      case 'integer':
        return Number.isFinite(num)
          ? new Intl.NumberFormat(options.locale, { maximumFractionDigits: 0 }).format(num)
          : String(value);
      case 'boolean':
        return value === true || value === 1 || ['true', 't', '1', 'yes'].includes(String(value).toLowerCase())
          ? 'Yes'
          : 'No';
      case 'date':
      case 'month': {
        const date = dateOnly(value);
        if (!date) return String(value);
        return new Intl.DateTimeFormat(options.locale, {
          timeZone: 'UTC',
          year: 'numeric',
          month: 'short',
          ...(format === 'date' ? { day: 'numeric' } : {}),
        }).format(date);
      }
      case 'datetime': {
        const date = value instanceof Date ? value : new Date(String(value));
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat(options.locale, {
          timeZone: options.timeZone,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(date);
      }
      case 'text':
        return value instanceof Date ? value.toISOString() : String(value);
    }
  } catch {
    return String(value);
  }
}

/** Calendar date from "YYYY-MM-DD…" or a Date, as UTC midnight (no time-zone shift). */
function dateOnly(value: unknown): Date | null {
  const text = value instanceof Date ? value.toISOString() : String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function isNumericFormat(format: FieldFormat | undefined): boolean {
  return format === 'currency' || format === 'number' || format === 'integer' || format === 'percent';
}
