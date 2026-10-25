import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiSearchClient, parseSearchResponse } from '../src/tools/documents/aiSearch.ts';

const chunk = (i: number, key = `policies/handbook-${i}.pdf`) => ({
  id: `c${i}`,
  type: 'text',
  score: 0.9 - i / 10,
  text: `Passage ${i}`,
  item: { key, timestamp: 1760000000 },
  scoring_details: { vector_score: 0.8 },
});

describe('Cloudflare AI Search client', () => {
  it('calls the 2026 /search endpoint with messages and retrieval options', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = new AiSearchClient({
      accountId: 'acc123',
      apiToken: 'cf-token',
      instance: 'business-docs',
      namespace: 'default',
      maxResults: 8,
      matchThreshold: 0.4,
      timeoutMs: 5_000,
      fetch: async (url, init) => {
        captured = { url: String(url), init: init ?? {} };
        return new Response(JSON.stringify({ success: true, errors: [], result: { search_query: 'pto', chunks: [chunk(1), chunk(2)] } }));
      },
    });
    const chunks = await client.search('How much PTO do part-timers get?');
    assert.equal(
      captured!.url,
      'https://api.cloudflare.com/client/v4/accounts/acc123/ai-search/namespaces/default/instances/business-docs/search',
    );
    const body = JSON.parse(String(captured!.init.body));
    assert.deepEqual(body, {
      messages: [{ role: 'user', content: 'How much PTO do part-timers get?' }],
      ai_search_options: { retrieval: { max_num_results: 8, match_threshold: 0.4 } },
    });
    assert.equal((captured!.init.headers as Record<string, string>).Authorization, 'Bearer cf-token');
    assert.deepEqual(chunks.map((c) => c.source), ['policies/handbook-1.pdf', 'policies/handbook-2.pdf']);
  });

  it('accepts unwrapped payloads (Workers binding shape) and skips empty chunks', () => {
    const parsed = parseSearchResponse({ chunks: [chunk(1), { id: 'x', text: '  ' }, { text: 'no item' }] });
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1]!.source, 'unknown source');
    assert.throws(() => parseSearchResponse({ result: {} }), /no chunks array/);
  });

  it('reports Cloudflare error envelopes', async () => {
    const client = new AiSearchClient({
      accountId: 'a',
      apiToken: 't',
      instance: 'i',
      namespace: 'default',
      maxResults: 5,
      matchThreshold: null,
      timeoutMs: 5_000,
      fetch: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 }),
    });
    await assert.rejects(client.search('q'), /403\): 10000 Authentication error/);
  });
});
