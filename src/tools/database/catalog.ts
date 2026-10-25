/**
 * The catalog is the allowlist and the "semantic layer": the only tables/views,
 * columns and metrics the agent may use, with descriptions the models read.
 * Anything not in the catalog can't be queried, whatever the model asks for.
 */

import { readFile } from 'node:fs/promises';

export type Engine = 'postgres' | 'sqlserver';
export type ColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime';

export const COLUMN_TYPES: readonly ColumnType[] = ['string', 'number', 'integer', 'boolean', 'date', 'datetime'];
export const ENGINES: readonly Engine[] = ['postgres', 'sqlserver'];

export interface CatalogColumn {
  name: string;
  type: ColumnType;
  description: string;
  /** A few real values, so the model writes filters the way the data is stored. Skip for sensitive columns. */
  sampleValues?: Array<string | number | boolean>;
}

export interface CatalogMetric {
  /** Name the model refers to, e.g. "revenue". */
  name: string;
  description: string;
  /**
   * Aggregate SQL expression, written by you (trusted, never by the model), e.g. "SUM(total_amount)".
   * Reference columns by their plain names; write it in this source's SQL dialect.
   */
  sql: string;
}

export interface CatalogTable {
  name: string;
  /** Database schema, e.g. "public" or "dbo". Optional. */
  schema?: string;
  description: string;
  columns: CatalogColumn[];
  metrics?: CatalogMetric[];
  /** Questions this table answers well; helps table selection. */
  exampleQuestions?: string[];
}

export interface CatalogSource {
  name: string;
  engine: Engine;
  /** Name of the environment variable holding the connection string. Secrets never live in the catalog. */
  connectionEnv: string;
  description?: string;
  tables: CatalogTable[];
}

export interface Catalog {
  sources: CatalogSource[];
}

export interface TableRef {
  source: CatalogSource;
  table: CatalogTable;
  /** Stable id used in table selection: "source.table". */
  id: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$ ]{0,127}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export async function loadCatalog(path: string): Promise<Catalog> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Couldn't read the catalog at ${path}. Copy catalog.example.json to catalog.json and describe your tables. (${String(error)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The catalog at ${path} isn't valid JSON: ${String(error)}`);
  }
  return validateCatalog(parsed);
}

/** Check the catalog's shape and return it typed. Throws one error listing every problem. */
export function validateCatalog(value: unknown): Catalog {
  const problems: string[] = [];
  const sources = isObject(value) && Array.isArray(value.sources) ? value.sources : null;
  if (!sources) throw new Error('Catalog must be an object with a "sources" array.');
  if (sources.length === 0) problems.push('Catalog has no sources.');

  const sourceNames = new Set<string>();
  sources.forEach((source: unknown, si: number) => {
    const where = `sources[${si}]`;
    if (!isObject(source)) return problems.push(`${where} must be an object.`);
    if (typeof source.name !== 'string' || !NAME.test(source.name)) problems.push(`${where}.name must be a simple name (letters, digits, _).`);
    else if (sourceNames.has(source.name)) problems.push(`${where}.name "${source.name}" is used twice.`);
    else sourceNames.add(source.name);
    if (!ENGINES.includes(source.engine as Engine)) problems.push(`${where}.engine must be "postgres" or "sqlserver".`);
    if (typeof source.connectionEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(source.connectionEnv)) {
      problems.push(`${where}.connectionEnv must name an environment variable, e.g. "SALES_DATABASE_URL".`);
    }
    if (!Array.isArray(source.tables) || source.tables.length === 0) return problems.push(`${where}.tables must list at least one table or view.`);

    const tableNames = new Set<string>();
    source.tables.forEach((table: unknown, ti: number) => {
      const tw = `${where}.tables[${ti}]`;
      if (!isObject(table)) return problems.push(`${tw} must be an object.`);
      if (typeof table.name !== 'string' || !IDENTIFIER.test(table.name)) problems.push(`${tw}.name is missing or has unsupported characters.`);
      else if (tableNames.has(table.name)) problems.push(`${tw}.name "${table.name}" is used twice in this source.`);
      else tableNames.add(table.name);
      if (table.schema !== undefined && (typeof table.schema !== 'string' || !IDENTIFIER.test(table.schema))) problems.push(`${tw}.schema has unsupported characters.`);
      if (typeof table.description !== 'string' || table.description.trim() === '') problems.push(`${tw}.description is required; it's what the model reads to pick a table.`);
      if (!Array.isArray(table.columns) || table.columns.length === 0) return problems.push(`${tw}.columns must list at least one column.`);

      const columnNames = new Set<string>();
      table.columns.forEach((column: unknown, ci: number) => {
        const cw = `${tw}.columns[${ci}]`;
        if (!isObject(column)) return problems.push(`${cw} must be an object.`);
        if (typeof column.name !== 'string' || !IDENTIFIER.test(column.name)) problems.push(`${cw}.name is missing or has unsupported characters.`);
        else if (columnNames.has(column.name)) problems.push(`${cw}.name "${column.name}" is used twice.`);
        else columnNames.add(column.name);
        if (!COLUMN_TYPES.includes(column.type as ColumnType)) problems.push(`${cw}.type must be one of ${COLUMN_TYPES.join(', ')}.`);
        if (typeof column.description !== 'string') problems.push(`${cw}.description is required (it can be short).`);
        if (column.sampleValues !== undefined && !Array.isArray(column.sampleValues)) problems.push(`${cw}.sampleValues must be an array.`);
      });

      if (table.metrics !== undefined) {
        if (!Array.isArray(table.metrics)) return problems.push(`${tw}.metrics must be an array.`);
        const metricNames = new Set<string>();
        table.metrics.forEach((metric: unknown, mi: number) => {
          const mw = `${tw}.metrics[${mi}]`;
          if (!isObject(metric)) return problems.push(`${mw} must be an object.`);
          if (typeof metric.name !== 'string' || !NAME.test(metric.name)) problems.push(`${mw}.name must be a simple name.`);
          else if (metricNames.has(metric.name) || columnNames.has(metric.name)) problems.push(`${mw}.name "${metric.name}" clashes with another metric or column.`);
          else metricNames.add(metric.name);
          if (typeof metric.description !== 'string') problems.push(`${mw}.description is required.`);
          if (typeof metric.sql !== 'string' || metric.sql.trim() === '') problems.push(`${mw}.sql is required.`);
          else if (/;|--|\/\*/.test(metric.sql)) problems.push(`${mw}.sql must be a single expression (no ";" or comments).`);
        });
      }
    });
  });

  if (problems.length > 0) throw new Error(`Catalog problems:\n- ${problems.join('\n- ')}`);
  return value as unknown as Catalog;
}

export function listTables(catalog: Catalog): TableRef[] {
  return catalog.sources.flatMap((source) =>
    source.tables.map((table) => ({ source, table, id: `${source.name}.${table.name}` })),
  );
}

export function findTable(catalog: Catalog, id: string): TableRef | undefined {
  return listTables(catalog).find((ref) => ref.id === id);
}

/** One-paragraph summary used as a Decisions API choice description. */
export function describeTableForSelection(ref: TableRef, maxLength = 900): string {
  const parts = [ref.table.description.trim()];
  if (ref.source.description) parts.push(`Database: ${ref.source.description.trim()}`);
  parts.push(`Columns: ${ref.table.columns.map((c) => c.name).join(', ')}.`);
  if (ref.table.metrics?.length) parts.push(`Metrics: ${ref.table.metrics.map((m) => m.name).join(', ')}.`);
  if (ref.table.exampleQuestions?.length) parts.push(`Answers questions like: ${ref.table.exampleQuestions.join(' | ')}`);
  const text = parts.join(' ');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
