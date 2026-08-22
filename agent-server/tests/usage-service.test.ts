// input:  usage service/store, PI cache, gateway quota/spend fakes
// output: cached quota, freshness, race, failure, and spend regressions
// pos:    Validates the public provider usage orchestration boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import type { AgentAdapter, Backend } from '../src/agent-adapter/types.js';
import { Capability } from '../src/agent-adapter/capabilities.js';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import { reportCodexQuota } from '../src/agent-adapter/pi/quota-sink.js';
import {
  UsageService,
  type UsageServiceStore,
} from '../src/domain/costs/usage-service.js';
import {
  UsageStore,
  type ProviderUsage,
} from '../src/domain/costs/usage-store.js';

class MemoryUsageStore implements UsageServiceStore {
  private readonly records = new Map<string, ProviderUsage>();
  listCalls = 0;
  updateCalls = 0;

  constructor(records: ProviderUsage[] = []) {
    for (const record of records) this.records.set(record.provider, structuredClone(record));
  }

  async list(): Promise<ProviderUsage[]> {
    this.listCalls += 1;
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  async get(provider: string): Promise<ProviderUsage | null> {
    const record = this.records.get(provider);
    return record ? structuredClone(record) : null;
  }

  async update(record: ProviderUsage): Promise<void> {
    this.updateCalls += 1;
    this.records.set(record.provider, structuredClone(record));
  }
}

function usage(
  provider: string,
  freshness: ProviderUsage['freshness'],
  options: Partial<ProviderUsage> = {},
): ProviderUsage {
  return {
    provider,
    displayName: provider,
    modes: [provider],
    windows: [],
    observedAt: freshness === 'never' || freshness === 'unsupported' ? null : 1_700_000_000,
    freshness,
    ...options,
  };
}

function fakeAdapter(
  backend: Backend,
  getUsage: NonNullable<AgentAdapter['getUsage']>,
): AgentAdapter {
  return {
    backend,
    capabilities: new Set([Capability.Usage]),
    getUsage,
  } as AgentAdapter;
}

function gatewayResponse(providers: unknown, status = 200): Response {
  return new Response(JSON.stringify({ providers }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function gatewayQuotaResponse(providers: unknown, status = 200): Response {
  return new Response(JSON.stringify({ providers }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function gatewayFetch(
  todayProviders: unknown,
  monthProviders: unknown,
  quotaProviders: unknown = [],
): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url.includes('/quota?')) return gatewayQuotaResponse(quotaProviders);
    return gatewayResponse(url.includes('period=today') ? todayProviders : monthProviders);
  }) as typeof fetch;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function durableMemoryStore(): UsageStore {
  let records: ProviderUsage[] = [];
  return new UsageStore({
    load: async () => structuredClone(records),
    save: async (next) => { records = structuredClone(next); },
  });
}

function serviceWith(options: {
  store?: MemoryUsageStore;
  anthropicModes?: string[];
  claude?: AgentAdapter;
  pi?: AgentAdapter;
  fetch?: typeof globalThis.fetch;
}) {
  const store = options.store ?? new MemoryUsageStore();
  const claude = options.claude ?? fakeAdapter('claude', async () => []);
  const pi = options.pi ?? fakeAdapter('pi', async () => []);
  const adapters: Record<Backend, AgentAdapter> = { claude, pi };
  const service = new UsageService({
    store,
    getAdapter: (backend) => adapters[backend],
    getSettings: () => ({ anthropicSubscriptionModes: options.anthropicModes ?? ['plan'] }),
    fetch: options.fetch ?? gatewayFetch([], []),
    gatewayUrl: 'http://gateway.test',
  });
  return { service, store };
}

describe('UsageService', () => {
  test('status is a side-effect-free read that hides legacy Anthropic model-scoped rows', async () => {
    const persisted = usage('anthropic', 'live', { windows: [
      { type: 'five_hour', utilization: 0.2, resetsAt: 1_800_000_000 },
      { type: 'model_scoped', label: 'Fable', utilization: 0.9, resetsAt: 1_800_000_000 },
    ] });
    const store = new MemoryUsageStore([persisted]);
    const claude = fakeAdapter('claude', vi.fn(async () => []));
    const pi = fakeAdapter('pi', vi.fn(async () => []));
    const fetch = vi.fn();
    const { service } = serviceWith({ store, claude, pi, fetch: fetch as typeof globalThis.fetch });

    assert.deepEqual(await service.getStatus(), [{
      ...persisted,
      windows: [persisted.windows[0]],
      freshness: 'stale',
    }]);
    assert.equal(store.updateCalls, 0);
    assert.equal(claude.getUsage && vi.mocked(claude.getUsage).mock.calls.length, 0);
    assert.equal(pi.getUsage && vi.mocked(pi.getUsage).mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
  });

  test('collect reads Anthropic quota from the gateway without resolving the Claude adapter', async () => {
    const store = new MemoryUsageStore();
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'never', {
      displayName: 'OpenAI Codex', modes: ['openai-codex'],
    })]);
    const getAdapter = vi.fn((backend: Backend) => {
      if (backend === 'claude') throw new Error('Claude usage collection must not be resolved');
      return pi;
    });
    const fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/quota?provider=anthropic')) {
        return gatewayQuotaResponse([{
          provider: 'anthropic', mode: 'plan', observed_at: 1_786_000_000,
          windows: [
            { type: 'five_hour', utilization: 0.34, resets_at: 1_787_428_800 },
            { type: 'seven_day', utilization: 0.61, resets_at: 1_787_860_800 },
            { type: 'model_scoped', utilization: 0.99, resets_at: 1_787_860_800 },
          ],
        }]);
      }
      return gatewayResponse([]);
    }) as typeof globalThis.fetch;
    const service = new UsageService({
      store,
      getAdapter,
      getSettings: () => ({ anthropicSubscriptionModes: ['plan', 'team'] }),
      fetch,
      gatewayUrl: 'http://gateway.test',
    });

    const result = await service.collect();
    assert.deepEqual(result.find(record => record.provider === 'anthropic'), {
      provider: 'anthropic', displayName: 'Anthropic', modes: ['plan', 'team'],
      windows: [
        { type: 'five_hour', utilization: 0.34, resetsAt: 1_787_428_800 },
        { type: 'seven_day', utilization: 0.61, resetsAt: 1_787_860_800 },
      ],
      observedAt: 1_786_000_000,
      freshness: 'stale',
    });
    assert.deepEqual(getAdapter.mock.calls.map(([backend]) => backend), ['pi']);
    assert.equal(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/quota?')).length, 1);
  });

  test('collect publishes stale, never, and unsupported provider states', async () => {
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'stale', {
      displayName: 'OpenAI Codex',
      modes: ['openai-codex'],
      windows: [{ type: 'codex_primary', utilization: 0.2, resetsAt: null }],
    })]);
    const fetch = gatewayFetch(
      [{ provider: 'deepseek', cost_usd: 1.25 }],
      [{ provider: 'deepseek', cost_usd: 4.5 }],
      [{
        provider: 'anthropic', mode: 'plan', observed_at: 1_700_000_000,
        windows: [{ type: 'five_hour', utilization: 0.34, resets_at: 1_800_000_100 }],
      }],
    );
    const { service } = serviceWith({
      pi,
      fetch,
      anthropicModes: [' plan ', '', 'team', 'plan'],
    });

    const result = await service.collect();

    assert.deepEqual(result.map(({ provider, freshness }) => ({ provider, freshness })), [
      { provider: 'anthropic', freshness: 'stale' },
      { provider: 'deepseek', freshness: 'unsupported' },
      { provider: 'openai-codex', freshness: 'stale' },
      { provider: 'qwen-ksu', freshness: 'unsupported' },
    ]);
    assert.deepEqual(result.find((record) => record.provider === 'anthropic')?.modes, ['plan', 'team']);
    assert.deepEqual(result.find((record) => record.provider === 'deepseek')?.spend, {
      today: 1.25,
      month: 4.5,
    });
    assert.deepEqual(result.find((record) => record.provider === 'qwen-ksu')?.spend, {
      today: 0,
      month: 0,
    });

    const coldPi = fakeAdapter('pi', async () => [usage('openai-codex', 'never', {
      displayName: 'OpenAI Codex',
      modes: ['openai-codex'],
    })]);
    const cold = serviceWith({ pi: coldPi }).service;
    assert.equal(
      (await cold.collect()).find((record) => record.provider === 'openai-codex')?.freshness,
      'never',
    );
  });

  test('a cached PI collection snapshot cannot overwrite a newer quota push', async () => {
    const store = durableMemoryStore();
    await store.update(usage('openai-codex', 'stale', {
      modes: ['openai-codex'],
      windows: [{ type: 'codex_primary', utilization: 0.1, resetsAt: null }],
      observedAt: 100,
    }));
    const snapshotRead = deferred();
    const releaseSnapshot = deferred();
    const pi = new PIAdapter(
      (() => { throw new Error('usage collection must not spawn PI'); }) as never,
      undefined,
      undefined,
      { usageStore: {
        get: async (provider) => {
          const snapshot = await store.get(provider);
          snapshotRead.resolve();
          await releaseSnapshot.promise;
          return snapshot;
        },
        update: (record) => store.update(record),
      } },
    );
    const claude = fakeAdapter('claude', async () => []);
    const service = new UsageService({
      store,
      getAdapter: (backend) => backend === 'pi' ? pi : claude,
      getSettings: () => ({ anthropicSubscriptionModes: [] }),
      fetch: gatewayFetch([], []),
      gatewayUrl: 'http://gateway.test',
    });

    const collection = service.collect();
    await snapshotRead.promise;
    await reportCodexQuota(
      {
        provider: 'openai-codex',
        planType: 'pro',
        windows: [{ type: 'codex_primary', utilization: 0.9, resetsAt: null }],
      },
      { provider: 'openai-codex', displayName: 'OpenAI Codex', mode: 'openai-codex' },
      { usageStore: store, submit: async () => {}, now: () => 200_000 },
    );
    assert.equal((await store.get('openai-codex'))?.observedAt, 200);

    releaseSnapshot.resolve();
    await collection;

    const persisted = await store.get('openai-codex');
    assert.equal(persisted?.observedAt, 200);
    assert.equal(persisted?.windows[0].utilization, 0.9);
  });

  test('every explicit refresh reads each enabled cache and gateway source once', async () => {
    const claudeGetUsage = vi.fn(async () => [usage('anthropic', 'live')]);
    const piGetUsage = vi.fn(async () => [usage('openai-codex', 'never')]);
    const fetch = gatewayFetch([], []);
    const { service } = serviceWith({
      claude: fakeAdapter('claude', claudeGetUsage),
      pi: fakeAdapter('pi', piGetUsage),
      fetch,
    });

    await service.refresh();
    await service.refresh();

    assert.equal(claudeGetUsage.mock.calls.length, 0);
    assert.equal(piGetUsage.mock.calls.length, 2);
    assert.equal(vi.mocked(fetch).mock.calls.length, 6);
    assert.equal(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/quota?')).length, 2);
  });

  test('empty Anthropic mode configuration disables gateway quota reads and clears attribution', async () => {
    const claudeGetUsage = vi.fn(async () => [usage('anthropic', 'live')]);
    const piGetUsage = vi.fn(async () => [usage('openai-codex', 'never')]);
    const store = new MemoryUsageStore([usage('anthropic', 'live', {
      modes: ['plan'],
      windows: [{ type: 'five_hour', utilization: 0.4, resetsAt: null }],
    })]);
    const fetch = gatewayFetch([], []);
    const { service } = serviceWith({
      store,
      anthropicModes: [],
      claude: fakeAdapter('claude', claudeGetUsage),
      pi: fakeAdapter('pi', piGetUsage),
      fetch,
    });

    const result = await service.collect();
    const anthropic = result.find((record) => record.provider === 'anthropic');

    assert.equal(claudeGetUsage.mock.calls.length, 0);
    assert.equal(piGetUsage.mock.calls.length, 1);
    assert.equal(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/quota?')).length, 0);
    assert.deepEqual(anthropic?.modes, []);
    assert.equal(anthropic?.freshness, 'stale');
    assert.deepEqual(anthropic?.windows, [{ type: 'five_hour', utilization: 0.4, resetsAt: null }]);
    assert.match(anthropic?.note ?? '', /disabled/);
  });

  test('gateway quota failures preserve prior values and do not abort other providers', async () => {
    const prior = usage('anthropic', 'live', {
      displayName: 'Anthropic',
      modes: ['plan'],
      windows: [
        { type: 'seven_day', utilization: 0.61, resetsAt: 1_900_000_000 },
        { type: 'model_scoped', label: 'Fable', utilization: 0.8, resetsAt: 1_900_000_000 },
      ],
    });
    const store = new MemoryUsageStore([prior]);
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'never')]);
    const fetch = vi.fn(async (input) => {
      if (String(input).includes('/quota?')) throw new Error('gateway offline');
      return gatewayResponse([]);
    }) as typeof globalThis.fetch;
    const { service } = serviceWith({ store, pi, fetch });

    const result = await service.collect();
    const anthropic = result.find((record) => record.provider === 'anthropic');

    assert.deepEqual(anthropic?.windows, [prior.windows[0]]);
    assert.equal(anthropic?.observedAt, prior.observedAt);
    assert.equal(anthropic?.freshness, 'stale');
    assert.match(anthropic?.note ?? '', /gateway offline/);
    assert.equal(result.find((record) => record.provider === 'openai-codex')?.freshness, 'never');
  });

  test('malformed gateway quota cannot erase the last valid observation', async () => {
    const prior = usage('anthropic', 'stale', {
      displayName: 'Anthropic', modes: ['plan'],
      windows: [{ type: 'five_hour', utilization: 0.4, resetsAt: 1_900_000_000 }],
    });
    const store = new MemoryUsageStore([prior]);
    const fetch = gatewayFetch([], [], [{
      provider: 'anthropic', mode: 'plan', observed_at: 1_800_000_000,
      windows: [{ type: 'five_hour', utilization: 2, resets_at: 1_900_000_100 }],
    }]);
    const { service } = serviceWith({ store, fetch });

    const anthropic = (await service.collect()).find(record => record.provider === 'anthropic');

    assert.deepEqual(anthropic?.windows, prior.windows);
    assert.equal(anthropic?.observedAt, prior.observedAt);
    assert.match(anthropic?.note ?? '', /utilization is invalid/);
  });

  test('a source with no observation remains never and does not throw', async () => {
    const { service } = serviceWith({
      pi: fakeAdapter('pi', async () => null),
    });

    const result = await service.collect();
    const anthropic = result.find((record) => record.provider === 'anthropic');
    const codex = result.find((record) => record.provider === 'openai-codex');

    assert.equal(anthropic?.freshness, 'never');
    assert.match(anthropic?.note ?? '', /no Anthropic quota observation/);
    assert.equal(codex?.freshness, 'never');
    assert.equal(codex?.note, undefined);
  });

  test('gateway provider grouping aggregates deepseek and both qwen aliases', async () => {
    const fetch = gatewayFetch(
      [
        { provider: 'deepseek', cost_usd: 1.2 },
        { provider: 'qwen', cost_usd: 2.3 },
        { provider: 'qwen-ksu', cost_usd: 0.4 },
        { provider: 'anthropic', cost_usd: 99 },
      ],
      [
        { provider: 'deepseek', cost_usd: 5.6 },
        { provider: 'qwen', cost_usd: 7.8 },
        { provider: 'qwen-ksu', cost_usd: 0.9 },
      ],
    );
    const { service } = serviceWith({ fetch });

    const result = await service.collect();

    assert.deepEqual(result.find((record) => record.provider === 'deepseek')?.spend, {
      today: 1.2,
      month: 5.6,
    });
    assert.deepEqual(result.find((record) => record.provider === 'qwen-ksu')?.spend, {
      today: 2.7,
      month: 8.7,
    });
    assert.deepEqual(
      vi.mocked(fetch).mock.calls.map(([input]) => String(input)).sort(),
      [
        'http://gateway.test/quota?provider=anthropic',
        'http://gateway.test/usage?period=month&group_by=provider',
        'http://gateway.test/usage?period=today&group_by=provider',
      ],
    );
  });

  test('a malformed provider cost does not discard a valid sibling provider', async () => {
    const store = new MemoryUsageStore([
      usage('deepseek', 'unsupported', {
        displayName: 'DeepSeek',
        modes: ['deepseek'],
        spend: { today: 3, month: 8 },
      }),
    ]);
    const fetch = gatewayFetch(
      [
        { provider: 'deepseek', cost_usd: 'bad' },
        { provider: 'qwen', cost_usd: 2.5 },
      ],
      [
        { provider: 'deepseek', cost_usd: 9 },
        { provider: 'qwen', cost_usd: 7.5 },
      ],
    );
    const { service } = serviceWith({ store, fetch });

    const result = await service.collect();

    assert.deepEqual(result.find((record) => record.provider === 'deepseek')?.spend, {
      today: 3,
      month: 9,
    });
    assert.match(result.find((record) => record.provider === 'deepseek')?.note ?? '', /today/);
    assert.deepEqual(result.find((record) => record.provider === 'qwen-ksu')?.spend, {
      today: 2.5,
      month: 7.5,
    });
    assert.equal(result.find((record) => record.provider === 'qwen-ksu')?.note, undefined);
  });

  test.each([
    ['gateway error', async () => { throw new Error('gateway offline'); }],
    ['429 response', async () => new Response('busy', { status: 429 })],
    ['timeout', async () => { throw new Error('request timed out'); }],
    ['parse failure', async () => gatewayResponse('invalid provider rows')],
  ])('%s preserves prior spend with unsupported quota freshness', async (_name, fetchImpl) => {
    const store = new MemoryUsageStore([
      usage('deepseek', 'unsupported', {
        displayName: 'DeepSeek',
        modes: ['deepseek'],
        spend: { today: 3, month: 8 },
      }),
      usage('qwen-ksu', 'unsupported', {
        displayName: 'Qwen KSU',
        modes: ['qwen-ksu'],
        spend: { today: 2, month: 7 },
      }),
    ]);
    const { service } = serviceWith({
      store,
      fetch: vi.fn(fetchImpl) as typeof globalThis.fetch,
    });

    const result = await service.refresh();

    for (const provider of ['deepseek', 'qwen-ksu']) {
      const record = result.find((candidate) => candidate.provider === provider);
      assert.equal(record?.freshness, 'unsupported');
      assert.deepEqual(record?.spend, provider === 'deepseek'
        ? { today: 3, month: 8 }
        : { today: 2, month: 7 });
      assert.ok(record?.note);
    }
  });
});
