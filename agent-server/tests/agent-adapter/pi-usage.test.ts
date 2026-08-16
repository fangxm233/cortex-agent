// input:  PIAdapter, scoped Codex usage cache, no-traffic spawner
// output: PI cold, cached stale, and scope usage regressions
// pos:    Validates PI push-only usage reads without provider traffic
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import type { ProviderUsage } from '../../src/domain/costs/usage-store.js';

function adapterWith(cached: ProviderUsage | null) {
  let spawnCalls = 0;
  let cacheReads = 0;
  const adapter = new PIAdapter(
    (() => {
      spawnCalls += 1;
      throw new Error('getUsage must not spawn PI');
    }) as never,
    undefined,
    undefined,
    {
      usageStore: {
        get: async () => {
          cacheReads += 1;
          return cached;
        },
        update: async () => {},
      },
    },
  );
  return {
    adapter,
    counts: () => ({ spawnCalls, cacheReads }),
  };
}

test('returns a never state for a scoped Codex cold start without provider traffic', async () => {
  const { adapter, counts } = adapterWith(null);

  assert.deepEqual(await adapter.getUsage?.({ provider: 'openai-codex', mode: 'openai-codex' }), [{
    provider: 'openai-codex',
    displayName: 'OpenAI Codex',
    modes: ['openai-codex'],
    windows: [],
    observedAt: null,
    freshness: 'never',
    note: 'push-only: waiting for next provider call',
  }]);
  assert.deepEqual(counts(), { spawnCalls: 0, cacheReads: 1 });
});

test('returns a cached Codex observation as stale with its observation time intact', async () => {
  const cached: ProviderUsage = {
    provider: 'openai-codex',
    displayName: 'OpenAI Codex',
    modes: ['openai-codex'],
    windows: [{ type: 'seven_day', utilization: 0.42, resetsAt: 1_786_160_107 }],
    observedAt: 1_786_000_000,
    freshness: 'live',
    note: 'push-only: observed during the latest provider call',
  };
  const { adapter, counts } = adapterWith(cached);

  assert.deepEqual(await adapter.getUsage?.({ provider: 'openai-codex', mode: 'openai-codex' }), [{
    ...cached,
    freshness: 'stale',
  }]);
  assert.deepEqual(counts(), { spawnCalls: 0, cacheReads: 1 });
});

test('rejects incomplete and non-Codex scopes without reading cache or spawning PI', async () => {
  const { adapter, counts } = adapterWith(null);

  assert.equal(await adapter.getUsage?.({ provider: 'openai-codex' }), null);
  assert.equal(await adapter.getUsage?.({ mode: 'openai-codex' }), null);
  assert.equal(await adapter.getUsage?.({ provider: 'deepseek', mode: 'deepseek' }), null);
  assert.deepEqual(counts(), { spawnCalls: 0, cacheReads: 0 });
});
