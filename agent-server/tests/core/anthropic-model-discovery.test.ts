import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'vitest';

import {
  anthropicModelIds,
  anthropicModelThinking,
  createAnthropicModelDiscovery,
  fetchAnthropicModels,
  type DiscoveredAnthropicModel,
} from '../../src/core/anthropic-model-discovery.js';

const CLAUDE_DIR = '/fixture/.claude';
const CREDENTIALS = path.join(CLAUDE_DIR, '.credentials.json');

function reader(files: Record<string, string>) {
  return (filePath: string): string => {
    const content = files[filePath];
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };
}

function apiModel(id: string, maxInput: number | null, effort?: Record<string, boolean>): unknown {
  return {
    type: 'model',
    id,
    display_name: id.toUpperCase(),
    max_input_tokens: maxInput,
    capabilities: effort
      ? {
        effort: {
          supported: true,
          ...Object.fromEntries(Object.entries(effort).map(([k, v]) => [k, { supported: v }])),
        },
      }
      : undefined,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function model(
  id: string, maxInputTokens: number | null, effortLevels: string[] | null = null,
): DiscoveredAnthropicModel {
  return { id, displayName: null, maxInputTokens, effortLevels };
}

test('the fetch goes through ANTHROPIC_BASE_URL with the resolved credential', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const models = await fetchAnthropicModels({
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9880/m/plan/x/anthropic/', ANTHROPIC_API_KEY: 'sk-ant-k' },
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({}),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return jsonResponse({ data: [apiModel('claude-opus-9', 1_000_000, { low: true, xhigh: false })] });
    }) as unknown as typeof fetch,
  });
  assert.equal(calls[0]?.url, 'http://127.0.0.1:9880/m/plan/x/anthropic/v1/models?limit=1000');
  assert.equal(calls[0]?.headers['x-api-key'], 'sk-ant-k');
  assert.deepEqual(models, [{
    id: 'claude-opus-9', displayName: 'CLAUDE-OPUS-9', maxInputTokens: 1_000_000, effortLevels: ['low'],
  }]);
});

test('no credential, a non-2xx answer or a shapeless body all throw, so the backoff applies', async () => {
  const noCredential = fetchAnthropicModels({
    env: {}, claudeConfigDir: CLAUDE_DIR, readFile: reader({}),
    fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
  });
  await assert.rejects(noCredential, /no Anthropic credential/);

  const credentialed = {
    env: { ANTHROPIC_API_KEY: 'sk-ant-k' }, claudeConfigDir: CLAUDE_DIR, readFile: reader({}),
  };
  await assert.rejects(
    fetchAnthropicModels({
      ...credentialed,
      fetchImpl: (async () => jsonResponse({ error: 'nope' }, 401)) as unknown as typeof fetch,
    }),
    /HTTP 401/,
  );
  await assert.rejects(
    fetchAnthropicModels({
      ...credentialed,
      fetchImpl: (async () => jsonResponse({ data: 'not-an-array' })) as unknown as typeof fetch,
    }),
    /no data array/,
  );
});

test('an OAuth store is sent as a Bearer token, and unparseable entries are dropped', async () => {
  let sent: Record<string, string> = {};
  const models = await fetchAnthropicModels({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({
      [CREDENTIALS]: JSON.stringify({ claudeAiOauth: { accessToken: 'store-token' } }),
    }),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      sent = init.headers as Record<string, string>;
      return jsonResponse({ data: [apiModel('claude-opus-9', 200_000), { id: '' }, 42, null] });
    }) as unknown as typeof fetch,
  });
  assert.equal(sent.authorization, 'Bearer store-token');
  assert.equal(models.length, 1);
});

test('ids: 1M models earn a [1m] twin, the shipped table fills the gaps, snapshots fold in', () => {
  const ids = anthropicModelIds(
    [model('claude-opus-9', 1_000_000), model('claude-haiku-4-5-20251001', 200_000)],
    ['claude-opus-9', 'claude-opus-9[1m]', 'claude-haiku-4-5', 'claude-legacy-1'],
  );
  assert.deepEqual(ids, [
    'claude-opus-9', 'claude-opus-9[1m]', 'claude-haiku-4-5-20251001', 'claude-legacy-1',
  ]);
});

test('ids: discovery answering nothing leaves the shipped table exactly as it was', () => {
  const shipped = ['claude-opus-9', 'claude-opus-9[1m]', 'claude-haiku-4-5'];
  assert.deepEqual(anthropicModelIds([], shipped), shipped);
});

test('thinking levels are reported per model and inherited by the [1m] twin', () => {
  const thinking = anthropicModelThinking([
    model('claude-opus-9', 1_000_000, ['low', 'high']),
    model('claude-quiet-1', 200_000, null),
  ]);
  assert.deepEqual(thinking, {
    'claude-opus-9': ['low', 'high'],
    'claude-opus-9[1m]': ['low', 'high'],
  });
});

test('peek never fetches; ensure waits out a cold fetch and then serves the cache', async () => {
  let fetches = 0;
  let now = 1_000;
  const discovery = createAnthropicModelDiscovery({
    fetchModels: async () => { fetches += 1; return [model('claude-opus-9', 1_000_000)]; },
    now: () => now,
    cacheTtlMs: 10_000,
    retryMs: 5_000,
  });

  assert.deepEqual(discovery.peek(), []);
  assert.equal(fetches, 0);

  assert.equal((await discovery.ensure(1_000)).length, 1);
  assert.equal(fetches, 1);

  now += 5_000;
  assert.equal((await discovery.ensure(1_000)).length, 1);
  assert.equal(fetches, 1, 'a warm cache is served without a second fetch');
});

test('a failed fetch is not retried until the backoff expires, and never throws at the caller', async () => {
  let fetches = 0;
  let now = 1_000;
  const discovery = createAnthropicModelDiscovery({
    fetchModels: async () => { fetches += 1; throw new Error('HTTP 401'); },
    now: () => now,
    cacheTtlMs: 10_000,
    retryMs: 5_000,
  });

  assert.deepEqual(await discovery.ensure(1_000), []);
  assert.equal(fetches, 1);

  now += 1_000;
  assert.deepEqual(await discovery.ensure(1_000), []);
  assert.equal(fetches, 1, 'still inside the backoff');

  now += 5_000;
  assert.deepEqual(await discovery.ensure(1_000), []);
  assert.equal(fetches, 2, 'the backoff expired, so one more attempt is made');
});
