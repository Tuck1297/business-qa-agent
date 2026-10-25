/**
 * Database tools you define (tools.json). They are the ONLY way the agent touches a database:
 * the model picks tools by name and description and fills in their parameters, and
 * your SQL runs with those parameters bound. The model never writes or sees SQL, and
 * never sees the rows (see src/merge).
 */

import { readFile } from 'node:fs/promises';
import { findNamedParams } from './sql.ts';

export type Engine = 'postgres' | 'sqlserver';
export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime';
export type FieldFormat =
  | 'text'
  | 'number'
  | 'integer'
  | 'currency'
  | 'percent'
  | 'date'
  | 'month'
  | 'datetime'
  | 'boolean';

export const ENGINES: readonly Engine[] = ['postgres', 'sqlserver'];
export const PARAM_TYPES: readonly ParamType[] = ['string', 'number', 'integer', 'boolean', 'date', 'datetime'];
export const FIELD_FORMATS: readonly FieldFormat[] = [
  'text',
  'number',
  'integer',
  'currency',
  'percent',
  'date',
  'month',
  'datetime',
  'boolean',
];

export interface ToolSource {
  name: string;
  engine: Engine;
  /** Environment variable that holds the connection string. Secrets never live in tools.json. */
  connectionEnv: string;
  description?: string;
}

export interface ToolParameter {
  name: string;
  type: ParamType;
  description: string;
  /** Defaults to true. Optional parameters arrive as null (or `default`) when the question doesn't specify them. */
  required?: boolean;
  enum?: Array<string | number>;
  default?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  /** For strings; defaults to 200. */
  maxLength?: number;
}

export interface OutputField {
  /** Column name returned by your SQL (use AS to name it). Used in merge fields: {{tool.field}}. */
  name: string;
  description: string;
  /** How the service formats the value when it fills a merge field. Defaults to text. */
  format?: FieldFormat;
  /** Column heading in {{table …}}. Defaults to the name. */
  label?: string;
}

export interface DbTool {
  /** snake_case; what the model calls and what merge fields start with. */
  name: string;
  /** When to use this tool. The model chooses tools by this text, so say what question it answers. */
  description: string;
  source: string;
  parameters: ToolParameter[];
  /**
   * One SELECT (or WITH … SELECT) using :named parameters, e.g. "WHERE invoice_date >= :start_date".
   * Put the ORDER BY you want in the SQL; the service only caps the row count.
   */
  sql: string;
  output: OutputField[];
  /** What the rows are and how they're ordered, e.g. "One row per customer, largest balance first." */
  resultDescription?: string;
  /** Row cap for this tool (the global MAX_ROWS still applies). */
  maxRows?: number;
  /** Example arguments, used by `npm run tools:check -- --run`. */
  example?: Record<string, string | number | boolean | null>;
}

export interface ToolSet {
  sources: ToolSource[];
  tools: DbTool[];
}

/** The Decisions API takes up to 400 questions per request; tool selection asks one per tool. */
export const MAX_TOOLS = 400;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SOURCE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function loadTools(path: string): Promise<ToolSet> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Couldn't read the tools file at ${path}. Copy tools.example.json to tools.json and define your tools. (${String(error)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The tools file at ${path} isn't valid JSON: ${String(error)}`);
  }
  return validateTools(parsed);
}

/** Check the whole file and throw one error listing every problem. */
export function validateTools(value: unknown): ToolSet {
  if (!isObject(value) || !Array.isArray(value.sources) || !Array.isArray(value.tools)) {
    throw new Error('The tools file must be an object with "sources" and "tools" arrays.');
  }
  const problems: string[] = [];
  const sources = new Map<string, Engine>();

  value.sources.forEach((source: unknown, i: number) => {
    const where = `sources[${i}]`;
    if (!isObject(source)) return problems.push(`${where} must be an object.`);
    if (typeof source.name !== 'string' || !SOURCE_NAME.test(source.name))
      problems.push(`${where}.name must be a simple name.`);
    else if (sources.has(source.name)) problems.push(`${where}.name "${source.name}" is used twice.`);
    if (!ENGINES.includes(source.engine as Engine)) problems.push(`${where}.engine must be "postgres" or "sqlserver".`);
    else if (typeof source.name === 'string') sources.set(source.name, source.engine as Engine);
    if (typeof source.connectionEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(source.connectionEnv)) {
      problems.push(`${where}.connectionEnv must name an environment variable, e.g. "SALES_DATABASE_URL".`);
    }
  });

  if (value.tools.length === 0) problems.push('Define at least one tool.');
  if (value.tools.length > MAX_TOOLS) problems.push(`At most ${MAX_TOOLS} tools are supported.`);

  const toolNames = new Set<string>();
  value.tools.forEach((tool: unknown, ti: number) => {
    const name = isObject(tool) && typeof tool.name === 'string' ? tool.name : `#${ti}`;
    const where = `tool "${name}"`;
    if (!isObject(tool)) return problems.push(`tools[${ti}] must be an object.`);
    if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name))
      problems.push(`${where}: name must be snake_case (a-z, 0-9, _), up to 48 characters.`);
    else if (toolNames.has(tool.name)) problems.push(`${where}: the name is used twice.`);
    else toolNames.add(tool.name);
    if (typeof tool.description !== 'string' || tool.description.trim().length < 10) {
      problems.push(`${where}: description is required; it's how the agent decides when to use the tool.`);
    }
    const engine = typeof tool.source === 'string' ? sources.get(tool.source) : undefined;
    if (!engine) problems.push(`${where}: source "${String(tool.source)}" isn't one of the sources.`);
    if (tool.resultDescription !== undefined && typeof tool.resultDescription !== 'string')
      problems.push(`${where}: resultDescription must be text.`);
    if (
      tool.maxRows !== undefined &&
      (!Number.isInteger(tool.maxRows) || (tool.maxRows as number) < 1 || (tool.maxRows as number) > 10_000)
    ) {
      problems.push(`${where}: maxRows must be a whole number from 1 to 10000.`);
    }

    // Parameters
    const params = Array.isArray(tool.parameters) ? tool.parameters : null;
    if (!params) problems.push(`${where}: parameters must be an array (it can be empty).`);
    const declared = new Map<string, ToolParameter>();
    (params ?? []).forEach((p: unknown, pi: number) => {
      const pw = `${where} parameter ${isObject(p) && typeof p.name === 'string' ? `"${p.name}"` : `#${pi}`}`;
      if (!isObject(p)) return problems.push(`${pw} must be an object.`);
      if (typeof p.name !== 'string' || !PARAM_NAME.test(p.name)) problems.push(`${pw}: name must be snake_case.`);
      else if (declared.has(p.name)) problems.push(`${pw}: declared twice.`);
      if (!PARAM_TYPES.includes(p.type as ParamType))
        problems.push(`${pw}: type must be one of ${PARAM_TYPES.join(', ')}.`);
      if (typeof p.description !== 'string' || p.description.trim() === '')
        problems.push(`${pw}: description is required (the model fills the value from it).`);
      if (p.required !== undefined && typeof p.required !== 'boolean')
        problems.push(`${pw}: required must be true or false.`);
      if (p.enum !== undefined) {
        if (!Array.isArray(p.enum) || p.enum.length === 0) problems.push(`${pw}: enum must be a non-empty array.`);
        else if (
          !p.enum.every((v) => typeof v === (p.type === 'number' || p.type === 'integer' ? 'number' : 'string'))
        ) {
          problems.push(`${pw}: enum values must match the parameter type.`);
        }
      }
      if (p.default !== undefined && p.default !== null && PARAM_TYPES.includes(p.type as ParamType)) {
        const ok = checkValueType(p.default, p.type as ParamType);
        if (!ok) problems.push(`${pw}: default doesn't match the type ${String(p.type)}.`);
      }
      for (const key of ['minimum', 'maximum', 'maxLength'] as const) {
        if (p[key] !== undefined && typeof p[key] !== 'number') problems.push(`${pw}: ${key} must be a number.`);
      }
      if (typeof p.name === 'string') declared.set(p.name, p as unknown as ToolParameter);
    });

    // SQL
    if (typeof tool.sql !== 'string' || tool.sql.trim() === '') {
      problems.push(`${where}: sql is required.`);
    } else if (engine) {
      for (const problem of checkSql(tool.sql, engine)) problems.push(`${where}: ${problem}`);
      const used = new Set(findNamedParams(tool.sql, engine).map((m) => m.name));
      for (const u of used)
        if (!declared.has(u)) problems.push(`${where}: the SQL uses :${u}, which isn't a declared parameter.`);
      for (const d of declared.keys())
        if (!used.has(d)) problems.push(`${where}: parameter "${d}" is declared but the SQL never uses :${d}.`);
    }

    // Output
    const output = Array.isArray(tool.output) ? tool.output : null;
    if (!output || output.length === 0) problems.push(`${where}: output must list the fields the SQL returns.`);
    const fieldNames = new Set<string>();
    (output ?? []).forEach((f: unknown, fi: number) => {
      const fw = `${where} output field ${isObject(f) && typeof f.name === 'string' ? `"${f.name}"` : `#${fi}`}`;
      if (!isObject(f)) return problems.push(`${fw} must be an object.`);
      if (typeof f.name !== 'string' || !FIELD_NAME.test(f.name))
        problems.push(`${fw}: name must be letters, digits and _ (name the column with AS).`);
      else if (fieldNames.has(f.name)) problems.push(`${fw}: listed twice.`);
      else fieldNames.add(f.name);
      if (typeof f.description !== 'string' || f.description.trim() === '')
        problems.push(`${fw}: description is required (the model writes the answer from it).`);
      if (f.format !== undefined && !FIELD_FORMATS.includes(f.format as FieldFormat))
        problems.push(`${fw}: format must be one of ${FIELD_FORMATS.join(', ')}.`);
      if (f.label !== undefined && typeof f.label !== 'string') problems.push(`${fw}: label must be text.`);
    });
  });

  if (problems.length > 0) throw new Error(`Tools file problems:\n- ${problems.join('\n- ')}`);
  return value as unknown as ToolSet;
}

/** Light checks that catch mistakes; the SQL is yours and trusted, and the database user should be read-only. */
export function checkSql(sql: string, engine: Engine): string[] {
  const problems: string[] = [];
  const body = normalizeSql(sql);
  if (!/^(select|with)\b/i.test(stripLeadingComments(body)))
    problems.push('sql must be a single SELECT (or WITH … SELECT) statement.');
  if (hasStatementSeparator(body, engine)) problems.push('sql must be one statement (no ";" in the middle).');
  return problems;
}

/** Remove a trailing semicolon so the service can wrap the statement. */
export function normalizeSql(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

export function findTool(set: ToolSet, name: string): DbTool | undefined {
  return set.tools.find((t) => t.name === name);
}

export function sourceOf(set: ToolSet, tool: DbTool): ToolSource {
  const source = set.sources.find((s) => s.name === tool.source);
  if (!source) throw new Error(`Tool "${tool.name}" refers to an unknown source "${tool.source}".`);
  return source;
}

export function isRequired(param: ToolParameter): boolean {
  return param.required !== false;
}

export function checkValueType(value: unknown, type: ParamType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && ISO_DATE.test(value);
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  }
}

function stripLeadingComments(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith('--')) s = s.slice(s.indexOf('\n') === -1 ? s.length : s.indexOf('\n') + 1).trimStart();
    else if (s.startsWith('/*')) s = s.slice(s.indexOf('*/') === -1 ? s.length : s.indexOf('*/') + 2).trimStart();
    else return s;
  }
}

/** True if a ";" appears outside strings, quoted identifiers and comments. */
function hasStatementSeparator(sql: string, engine: Engine): boolean {
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || (ch === '[' && engine === 'sqlserver')) {
      const close = ch === '[' ? ']' : ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) i += 2;
          else break;
        } else i++;
      }
      i++;
      continue;
    }
    if (ch === ';') return true;
    i++;
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
