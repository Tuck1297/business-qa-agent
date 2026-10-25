/**
 * Entry point: `npm start` (or `node --env-file=.env src/main.ts`).
 */

import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent/agent.ts';
import { loadConfig } from './config.ts';
import { OpenAiClient } from './llm/openai.ts';
import { attachWebSocket, closeWebSocket } from './server/ws.ts';
import { createHttpServer } from './server/http.ts';
import { loadCatalog } from './tools/database/catalog.ts';
import { DatabaseService } from './tools/database/service.ts';
import { AiSearchClient } from './tools/documents/aiSearch.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  let database: DatabaseService | null = null;
  if (await exists(config.database.catalogPath)) {
    const catalog = await loadCatalog(config.database.catalogPath);
    database = new DatabaseService(catalog, { timeoutMs: config.database.queryTimeoutMs });
    const tableCount = catalog.sources.reduce((n, s) => n + s.tables.length, 0);
    console.log(`[db] catalog loaded: ${catalog.sources.length} source(s), ${tableCount} table(s)/view(s)`);
  } else {
    console.warn(`[db] no catalog at ${config.database.catalogPath}; database questions are off. Copy catalog.example.json to start.`);
  }

  const documents = config.aiSearch ? new AiSearchClient(config.aiSearch) : null;
  if (!documents) console.warn('[docs] CF_AI_SEARCH_INSTANCE not set; document search is off.');

  const agent = new Agent({
    llm: new OpenAiClient(config.openai),
    database,
    documents,
    documentsDescription: process.env.DOCUMENTS_DESCRIPTION ?? 'company documents such as policies, procedures and contracts',
    timezone: config.timezone,
    maxRows: config.database.maxRows,
    showSql: config.database.showSql,
    predicateThreshold: config.routing.predicateThreshold,
    clarifyThreshold: config.routing.clarifyThreshold,
    tableConfidenceWarning: config.routing.tableConfidenceWarning,
  });

  const server = createHttpServer({
    agent,
    apiToken: config.apiToken,
    status: { database: database !== null, documents: documents !== null },
    indexHtmlPath: fileURLToPath(new URL('../public/index.html', import.meta.url)),
  });
  const wss = await attachWebSocket(server, agent, config.apiToken);

  server.listen(config.port, config.host, () => {
    console.log(`[http] listening on http://${config.host}:${config.port}${wss ? ' (WebSocket on /ws)' : ''}`);
    if (!config.apiToken) console.warn('[http] API_TOKEN not set: no authentication (allowed only because the server is on loopback).');
  });

  const shutdown = (signal: string) => {
    console.log(`[http] ${signal} received, shutting down`);
    if (wss) void closeWebSocket(wss);
    server.close(() => {
      void Promise.resolve(database?.close()).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
