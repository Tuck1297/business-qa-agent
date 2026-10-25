/**
 * Check tools.json before using it.
 *
 *   npm run tools:check                 validate the file, show each tool's bound SQL for its example
 *   npm run tools:check -- --run        also run every example against the database (read-only) and
 *                                       compare the columns it returns with the declared output fields
 *   npm run tools:check -- --file other-tools.json
 */

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateArguments } from '../src/tools/database/arguments.ts';
import { loadTools, sourceOf, type DbTool } from '../src/tools/database/definitions.ts';
import { DatabaseService } from '../src/tools/database/service.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { file: { type: 'string' }, run: { type: 'boolean' } } });
  const path = values.file ?? process.env.TOOLS_PATH ?? 'tools.json';
  const tools = await loadTools(path);
  const db = new DatabaseService(tools, {
    timeoutMs: Number(process.env.QUERY_TIMEOUT_MS ?? 10_000),
    maxRows: Number(process.env.MAX_ROWS ?? 200),
  });
  console.log(`${path}: ${tools.tools.length} tool(s), ${tools.sources.length} source(s). Valid.\n`);

  let failures = 0;
  try {
    for (const tool of tools.tools) {
      const source = sourceOf(tools, tool);
      console.log(`■ ${tool.name}  (${source.name}, ${source.engine})`);
      if (!tool.example) {
        console.log('  no "example" arguments; skipped\n');
        continue;
      }
      let args;
      try {
        args = validateArguments(tool, tool.example);
      } catch (error) {
        failures += 1;
        console.log(`  ✗ example arguments: ${(error as Error).message}\n`);
        continue;
      }
      const prepared = db.prepare(tool, args);
      console.log(indent(prepared.sql));
      console.log(`  -- params: ${JSON.stringify(prepared.params.map((p) => p.value))}`);
      if (values.run) failures += await runExample(db, tool, args);
      console.log('');
    }
  } finally {
    await db.close();
  }
  if (failures > 0) {
    console.error(`${failures} problem(s) found.`);
    process.exit(1);
  }
}

async function runExample(
  db: DatabaseService,
  tool: DbTool,
  args: Parameters<DatabaseService['run']>[1],
): Promise<number> {
  try {
    const started = Date.now();
    const result = await db.run(tool, args);
    const declared = tool.output.map((f) => f.name);
    const returned = result.rows[0] ? Object.keys(result.rows[0]) : [];
    const missing = declared.filter((name) => result.rows.length > 0 && !returned.includes(name));
    const extra = returned.filter((name) => !declared.includes(name));
    console.log(
      `  ✓ ${result.rows.length} row(s)${result.truncated ? ' (truncated)' : ''} in ${Date.now() - started} ms`,
    );
    if (result.rows[0]) console.log(`  first row: ${JSON.stringify(result.rows[0])}`);
    if (extra.length)
      console.log(`  note: returned but not declared (not usable in merge fields): ${extra.join(', ')}`);
    if (missing.length) {
      console.log(
        `  ✗ declared but not returned (merge fields will be empty): ${missing.join(', ')}. Name the columns with AS.`,
      );
      return 1;
    }
    return 0;
  } catch (error) {
    console.log(`  ✗ ${(error as Error).message}`);
    return 1;
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
