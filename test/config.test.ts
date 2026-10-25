import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';

const minimal = { OPENAI_API_KEY: 'sk-x' };

describe('config', () => {
  it('has safe local defaults', () => {
    const c = loadConfig(minimal);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.port, 8787);
    assert.equal(c.apiToken, null);
    assert.equal(c.openai.decisionModel, 'gpt-6-luna');
    assert.equal(c.openai.model, 'gpt-6-astra');
    assert.equal(c.aiSearch, null);
    assert.equal(c.database.toolsPath, 'tools.json');
    assert.equal(c.database.maxRows, 200);
    assert.equal(c.database.maxToolCalls, 4);
    assert.equal(c.database.showSql, true);
    assert.equal(c.routing.toolSelectThreshold, 0.5);
    assert.deepEqual(c.format, { locale: 'en-US', currency: 'USD' });
  });

  it('validates the locale and currency used to format merge fields', () => {
    assert.deepEqual(loadConfig({ ...minimal, LOCALE: 'de-DE', CURRENCY: 'eur' }).format, {
      locale: 'de-DE',
      currency: 'EUR',
    });
    assert.throws(() => loadConfig({ ...minimal, CURRENCY: 'DOLLARS' }), /CURRENCY/);
    assert.throws(
      () => loadConfig({ ...minimal, MAX_TOOL_CALLS: '20' }),
      /MAX_TOOL_CALLS must be a number from 1 to 8/,
    );
  });

  it('refuses to listen on a network address without API_TOKEN', () => {
    assert.throws(() => loadConfig({ ...minimal, HOST: '0.0.0.0' }), /API_TOKEN is required/);
    assert.equal(loadConfig({ ...minimal, HOST: '0.0.0.0', API_TOKEN: 'secret' }).apiToken, 'secret');
  });

  it('enables AI Search only with its account and token', () => {
    assert.throws(() => loadConfig({ ...minimal, CF_AI_SEARCH_INSTANCE: 'docs' }), /CF_ACCOUNT_ID/);
    const c = loadConfig({
      ...minimal,
      CF_AI_SEARCH_INSTANCE: 'docs',
      CF_ACCOUNT_ID: 'a',
      CF_API_TOKEN: 't',
      CF_AI_SEARCH_MATCH_THRESHOLD: '0.3',
    });
    assert.deepEqual(
      {
        instance: c.aiSearch?.instance,
        namespace: c.aiSearch?.namespace,
        max: c.aiSearch?.maxResults,
        threshold: c.aiSearch?.matchThreshold,
      },
      { instance: 'docs', namespace: 'default', max: 10, threshold: 0.3 },
    );
  });

  it('validates numbers and requires the OpenAI key', () => {
    assert.throws(() => loadConfig({}), /OPENAI_API_KEY/);
    assert.throws(() => loadConfig({ ...minimal, MAX_ROWS: 'lots' }), /MAX_ROWS must be a number/);
    assert.throws(
      () =>
        loadConfig({
          ...minimal,
          CF_AI_SEARCH_INSTANCE: 'd',
          CF_ACCOUNT_ID: 'a',
          CF_API_TOKEN: 't',
          CF_AI_SEARCH_MAX_RESULTS: '80',
        }),
      /from 1 to 50/,
    );
    assert.throws(() => loadConfig({ ...minimal, PORT: '80.5' }), /whole number/);
    assert.equal(loadConfig({ ...minimal, SHOW_SQL: 'false' }).database.showSql, false);
  });
});
