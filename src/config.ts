/**
 * All settings come from environment variables (see .env.example).
 * Node 22+ can load a .env file with `node --env-file=.env src/main.ts`.
 */

export interface Config {
  host: string;
  port: number;
  /** Bearer token for the HTTP API and WebSocket. Required unless the server only listens on loopback. */
  apiToken: string | null;
  timezone: string;

  openai: {
    apiKey: string;
    baseUrl: string;
    /** Decisions API model for routing and table selection. */
    decisionModel: string;
    /** Responses API model for building queries and writing answers. */
    model: string;
    timeoutMs: number;
  };

  routing: {
    /** Probability at or above which a predicate counts as true. */
    predicateThreshold: number;
    /** Ask a follow-up question when "is ambiguous" is at least this likely. */
    clarifyThreshold: number;
    /** Below this confidence the table choice is flagged as uncertain in the step data. */
    tableConfidenceWarning: number;
  };

  aiSearch: {
    accountId: string;
    apiToken: string;
    instance: string;
    namespace: string;
    maxResults: number;
    matchThreshold: number | null;
    timeoutMs: number;
    /** Cloudflare API base URL; override only for testing or a proxy. */
    baseUrl: string;
  } | null;

  database: {
    catalogPath: string;
    maxRows: number;
    queryTimeoutMs: number;
    /** Include the generated SQL and parameters in step events. */
    showSql: boolean;
  };
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const host = env.HOST ?? '127.0.0.1';
  const apiToken = blankToNull(env.API_TOKEN);
  if (!apiToken && !isLoopback(host)) {
    throw new Error(
      `API_TOKEN is required when HOST is ${host}. The agent can read business data, so it refuses to listen on a network address without one.`,
    );
  }

  const aiSearchInstance = blankToNull(env.CF_AI_SEARCH_INSTANCE);
  let aiSearch: Config['aiSearch'] = null;
  if (aiSearchInstance) {
    aiSearch = {
      accountId: required(env, 'CF_ACCOUNT_ID'),
      apiToken: required(env, 'CF_API_TOKEN'),
      instance: aiSearchInstance,
      namespace: env.CF_AI_SEARCH_NAMESPACE ?? 'default',
      maxResults: intInRange(env, 'CF_AI_SEARCH_MAX_RESULTS', 10, 1, 50),
      matchThreshold: optionalNumberInRange(env, 'CF_AI_SEARCH_MATCH_THRESHOLD', 0, 1),
      timeoutMs: intInRange(env, 'CF_AI_SEARCH_TIMEOUT_MS', 15_000, 1_000, 120_000),
      baseUrl: (env.CF_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, ''),
    };
  }

  return {
    host,
    port: intInRange(env, 'PORT', 8787, 0, 65_535),
    apiToken,
    timezone: env.TIMEZONE ?? 'America/Chicago',
    openai: {
      apiKey: required(env, 'OPENAI_API_KEY'),
      baseUrl: (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      decisionModel: env.OPENAI_DECISION_MODEL ?? 'gpt-6-luna',
      model: env.OPENAI_MODEL ?? 'gpt-6-astra',
      timeoutMs: intInRange(env, 'OPENAI_TIMEOUT_MS', 60_000, 1_000, 600_000),
    },
    routing: {
      predicateThreshold: numberInRange(env, 'ROUTE_PREDICATE_THRESHOLD', 0.5, 0, 1),
      clarifyThreshold: numberInRange(env, 'ROUTE_CLARIFY_THRESHOLD', 0.7, 0, 1),
      tableConfidenceWarning: numberInRange(env, 'TABLE_CONFIDENCE_WARNING', 0.6, 0, 1),
    },
    aiSearch,
    database: {
      catalogPath: env.CATALOG_PATH ?? 'catalog.json',
      maxRows: intInRange(env, 'MAX_ROWS', 200, 1, 10_000),
      queryTimeoutMs: intInRange(env, 'QUERY_TIMEOUT_MS', 10_000, 100, 300_000),
      showSql: (env.SHOW_SQL ?? 'true').toLowerCase() !== 'false',
    },
  };
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function blankToNull(value: string | undefined): string | null {
  return value && value.trim() !== '' ? value.trim() : null;
}

function required(env: Env, name: string): string {
  const value = blankToNull(env[name]);
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function numberInRange(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = blankToNull(env[name]);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max} (got "${raw}").`);
  }
  return value;
}

function intInRange(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = numberInRange(env, name, fallback, min, max);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
  return value;
}

function optionalNumberInRange(env: Env, name: string, min: number, max: number): number | null {
  return blankToNull(env[name]) === null ? null : numberInRange(env, name, 0, min, max);
}
