/**
 * Draft a catalog from a database's information_schema, so you only have to write descriptions.
 *
 *   node --env-file=.env scripts/draft-catalog.ts --source sales --engine postgres \
 *        --env SALES_DATABASE_URL --schema reporting > catalog.draft.json
 *
 * Then: delete tables the agent shouldn't see, replace every "TODO" with a real description,
 * add metrics and a few sampleValues, and save it as catalog.json.
 * Prefer pointing the agent at views you've written for it over raw tables.
 */

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Catalog, CatalogTable, ColumnType, Engine } from '../src/tools/database/catalog.ts';
import { createPostgresAdapter } from '../src/tools/database/adapters/postgres.ts';
import { createSqlServerAdapter } from '../src/tools/database/adapters/sqlserver.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      engine: { type: 'string' },
      env: { type: 'string' },
      schema: { type: 'string' },
    },
  });
  const engine = values.engine as Engine | undefined;
  if (!values.source || !values.env || (engine !== 'postgres' && engine !== 'sqlserver')) {
    throw new Error('Usage: draft-catalog.ts --source <name> --engine postgres|sqlserver --env <CONNECTION_ENV_VAR> [--schema <schema>]');
  }
  const connectionString = process.env[values.env];
  if (!connectionString) throw new Error(`Environment variable ${values.env} isn't set.`);
  const schema = values.schema ?? (engine === 'postgres' ? 'public' : 'dbo');

  const adapter = engine === 'postgres' ? await createPostgresAdapter(connectionString) : await createSqlServerAdapter(connectionString, 30_000);
  const sql =
    engine === 'postgres'
      ? `SELECT c.table_name, c.column_name, c.data_type, t.table_type
           FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = $1
          ORDER BY c.table_name, c.ordinal_position`
      : `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type, t.TABLE_TYPE AS table_type
           FROM INFORMATION_SCHEMA.COLUMNS c
           JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
          WHERE c.TABLE_SCHEMA = @p1
          ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`;

  try {
    const rows = await adapter.query(sql, [schema], { timeoutMs: 30_000 });
    const tables = new Map<string, CatalogTable>();
    for (const row of rows) {
      const tableName = String(row.table_name);
      let table = tables.get(tableName);
      if (!table) {
        const kind = String(row.table_type).toUpperCase().includes('VIEW') ? 'view' : 'table';
        table = { name: tableName, schema, description: `TODO: what one row of this ${kind} represents and what it's for.`, columns: [] };
        tables.set(tableName, table);
      }
      table.columns.push({ name: String(row.column_name), type: mapType(String(row.data_type)), description: 'TODO' });
    }
    const catalog: Catalog = {
      sources: [{ name: values.source, engine, connectionEnv: values.env, description: 'TODO: what this database is about.', tables: [...tables.values()] }],
    };
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    console.error(`Drafted ${tables.size} table(s)/view(s) from schema "${schema}". Fill in the TODOs before using it.`);
  } finally {
    await adapter.close();
  }
}

export function mapType(dataType: string): ColumnType {
  const t = dataType.toLowerCase();
  if (/^(smallint|integer|int|int2|int4|int8|bigint|tinyint|serial|bigserial)$/.test(t)) return 'integer';
  if (/(numeric|decimal|real|double|float|money)/.test(t)) return 'number';
  if (t === 'boolean' || t === 'bool' || t === 'bit') return 'boolean';
  if (t === 'date') return 'date';
  if (/(timestamp|datetime|smalldatetime|datetimeoffset)/.test(t)) return 'datetime';
  return 'string';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
