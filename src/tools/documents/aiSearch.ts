/**
 * Cloudflare AI Search (formerly AutoRAG) retrieval over its REST API.
 *
 * Uses the retrieval-only `/search` endpoint, so the agent writes one answer from
 * database rows and document chunks together instead of getting a separate answer
 * back from AI Search's own generation step.
 *
 * Endpoint (2026 REST API):
 *   POST https://api.cloudflare.com/client/v4/accounts/{account}/ai-search/namespaces/{namespace}/instances/{instance}/search
 * The API token needs AI Search Run permission. The older
 * /autorag/rags/{name}/search endpoints still work, but this client uses the new ones.
 */

import { toText } from '../../text.ts';

export interface DocumentChunk {
  id: string;
  /** Source file path or URL in the data source (R2 key or crawled URL). */
  source: string;
  text: string;
  score: number;
  /** Unix seconds (or ms, depending on the source) of the item's last modification, when given. */
  timestamp: number | null;
}

export interface DocumentSearch {
  search(question: string, signal?: AbortSignal): Promise<DocumentChunk[]>;
}

export interface AiSearchOptions {
  accountId: string;
  apiToken: string;
  instance: string;
  namespace: string;
  maxResults: number;
  matchThreshold: number | null;
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class AiSearchClient implements DocumentSearch {
  private readonly options: AiSearchOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AiSearchOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  get url(): string {
    const o = this.options;
    const base = (o.baseUrl ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
    return `${base}/accounts/${encodeURIComponent(o.accountId)}/ai-search/namespaces/${encodeURIComponent(o.namespace)}/instances/${encodeURIComponent(o.instance)}/search`;
  }

  async search(question: string, signal?: AbortSignal): Promise<DocumentChunk[]> {
    const retrieval: Record<string, unknown> = { max_num_results: this.options.maxResults };
    if (this.options.matchThreshold !== null) retrieval.match_threshold = this.options.matchThreshold;

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: question }],
        ai_search_options: { retrieval },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`AI Search returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`);
    }
    if (!response.ok || (isObject(body) && body.success === false)) {
      throw new Error(`AI Search request failed (${response.status}): ${describeErrors(body) || text.slice(0, 300)}`);
    }
    return parseSearchResponse(body);
  }
}

/**
 * Read chunks from a search response. Cloudflare's v4 REST API wraps payloads in
 * { success, errors, messages, result }; the Workers binding returns the payload directly.
 * Both shapes are accepted.
 */
export function parseSearchResponse(body: unknown): DocumentChunk[] {
  const payload = isObject(body) && isObject(body.result) ? body.result : body;
  const chunks = isObject(payload) ? payload.chunks : undefined;
  if (!Array.isArray(chunks)) throw new Error('AI Search response has no chunks array.');
  return chunks.flatMap((chunk, i): DocumentChunk[] => {
    if (!isObject(chunk) || typeof chunk.text !== 'string' || chunk.text.trim() === '') return [];
    const item = isObject(chunk.item) ? chunk.item : {};
    return [
      {
        id: typeof chunk.id === 'string' ? chunk.id : `chunk-${i}`,
        source: typeof item.key === 'string' ? item.key : 'unknown source',
        text: chunk.text,
        score: typeof chunk.score === 'number' ? chunk.score : 0,
        timestamp: typeof item.timestamp === 'number' ? item.timestamp : null,
      },
    ];
  });
}

function describeErrors(body: unknown): string {
  if (!isObject(body) || !Array.isArray(body.errors)) return '';
  return body.errors
    .map((e) => (isObject(e) ? `${toText(e.code)} ${toText(e.message)}`.trim() : toText(e)))
    .filter(Boolean)
    .join('; ');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
