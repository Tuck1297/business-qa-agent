/**
 * Tool parameters ↔ what the model sees and returns.
 *
 * Each tool becomes an OpenAI function with a strict JSON Schema; the arguments the
 * model sends back are checked again here (types, required, enum, ranges, real dates)
 * because they end up as SQL parameters.
 */

import { checkValueType, isRequired, type DbTool, type ParamType, type ToolParameter } from './definitions.ts';

export type ArgValue = string | number | boolean | null;

export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

const JSON_TYPE: Record<ParamType, string> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  date: 'string',
  datetime: 'string',
};

export function toFunctionTool(tool: DbTool): FunctionTool {
  const properties: Record<string, unknown> = {};
  for (const p of tool.parameters) {
    const optional = !isRequired(p);
    const type = JSON_TYPE[p.type];
    const hints = [p.description.trim()];
    if (p.type === 'date') hints.push('Format YYYY-MM-DD.');
    if (p.type === 'datetime') hints.push('ISO 8601 date-time.');
    if (p.minimum !== undefined) hints.push(`Minimum ${p.minimum}.`);
    if (p.maximum !== undefined) hints.push(`Maximum ${p.maximum}.`);
    if (optional) hints.push(`Optional: use null if the question doesn't specify it${p.default !== undefined && p.default !== null ? ` (default ${JSON.stringify(p.default)})` : ''}.`);
    const schema: Record<string, unknown> = { type: optional ? [type, 'null'] : type, description: hints.join(' ') };
    if (p.enum) schema.enum = optional ? [...p.enum, null] : [...p.enum];
    properties[p.name] = schema;
  }
  return {
    type: 'function',
    name: tool.name,
    description: tool.description.trim(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      required: tool.parameters.map((p) => p.name),
    },
    strict: true,
  };
}

export class ArgumentError extends Error {
  readonly problems: string[];
  constructor(tool: string, problems: string[]) {
    super(`Arguments for ${tool} aren't valid:\n- ${problems.join('\n- ')}`);
    this.name = 'ArgumentError';
    this.problems = problems;
  }
}

/** Validate and coerce model-supplied arguments. Missing optional parameters become their default or null. */
export function validateArguments(tool: DbTool, raw: unknown): Record<string, ArgValue> {
  const problems: string[] = [];
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!input) throw new ArgumentError(tool.name, ['Arguments must be a JSON object.']);

  const declared = new Set(tool.parameters.map((p) => p.name));
  for (const key of Object.keys(input)) if (!declared.has(key)) problems.push(`"${key}" isn't a parameter of ${tool.name}.`);

  const values: Record<string, ArgValue> = {};
  for (const p of tool.parameters) {
    const given = input[p.name];
    if (given === undefined || given === null || given === '') {
      if (isRequired(p)) problems.push(`"${p.name}" is required.`);
      values[p.name] = p.default ?? null;
      continue;
    }
    const result = coerce(given, p);
    if (typeof result === 'object' && result !== null) problems.push(result.problem);
    else values[p.name] = result;
  }

  if (problems.length > 0) throw new ArgumentError(tool.name, problems);
  return values;
}

function coerce(value: unknown, p: ToolParameter): ArgValue | { problem: string } {
  const bad = (why: string) => ({ problem: `"${p.name}": ${why}` });
  let v: ArgValue;
  switch (p.type) {
    case 'number':
    case 'integer': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (!Number.isFinite(n)) return bad(`"${String(value)}" isn't a number.`);
      if (p.type === 'integer' && !Number.isInteger(n)) return bad(`"${String(value)}" isn't a whole number.`);
      if (p.minimum !== undefined && n < p.minimum) return bad(`must be at least ${p.minimum}.`);
      if (p.maximum !== undefined && n > p.maximum) return bad(`must be at most ${p.maximum}.`);
      v = n;
      break;
    }
    case 'boolean':
      if (typeof value === 'boolean') v = value;
      else if (value === 'true' || value === 'false') v = value === 'true';
      else return bad('must be true or false.');
      break;
    case 'date': {
      const s = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !isRealDate(s)) return bad(`"${s}" isn't a date in YYYY-MM-DD form.`);
      v = s;
      break;
    }
    case 'datetime': {
      const s = String(value).trim();
      if (!checkValueType(s, 'datetime') || !/^\d{4}-\d{2}-\d{2}/.test(s)) return bad(`"${s}" isn't an ISO date-time.`);
      v = s;
      break;
    }
    case 'string': {
      if (typeof value !== 'string' && typeof value !== 'number') return bad('must be text.');
      const s = String(value);
      if (s.length > (p.maxLength ?? 200)) return bad(`is longer than ${p.maxLength ?? 200} characters.`);
      v = s;
      break;
    }
  }
  if (p.enum && !p.enum.some((e) => e === v)) return bad(`must be one of ${p.enum.map((e) => JSON.stringify(e)).join(', ')}.`);
  return v;
}

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
