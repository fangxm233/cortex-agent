// input:  usage service/store, PI cache, quota sink, gateway fakes
// output: collection, freshness, race, failure, and spend regressions
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
  UsageUnavailableError,
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

function gatewayFetch(
  todayProviders: unknown,
  monthProviders: unknown,
): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
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
  test('status is a side-effect-free persisted-store read', async () => {
    const persisted = usage('anthropic', 'stale');
    const store = new MemoryUsageStore([persisted]);
    const claude = fakeAdapter('claude', vi.fn(async () => []));
    const pi = fakeAdapter('pi', vi.fn(async () => []));
    const fetch = vi.fn();
    const { service } = serviceWith({ store, claude, pi, fetch: fetch as typeof globalThis.fetch });

    assert.deepEqual(await service.getStatus(), [persisted]);
    assert.equal(store.updateCalls, 0);
    assert.equal(claude.getUsage && vi.mocked(claude.getUsage).mock.calls.length, 0);
    assert.equal(pi.getUsage && vi.mocked(pi.getUsage).mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
  });

  test('collect publishes live, stale, never, and unsupported provider states', async () => {
    const claude = fakeAdapter('claude', async () => [usage('anthropic', 'live', {
      displayName: 'Anthropic',
      modes: ['collector-mode'],
      windows: [{ type: 'five_hour', utilization: 0.34, resetsAt: 1_800_000_100 }],
    })]);
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'stale', {
      displayName: 'OpenAI Codex',
      modes: ['openai-codex'],
      windows: [{ type: 'codex_primary', utilization: 0.2, resetsAt: null }],
    })]);
    const fetch = gatewayFetch(
      [{ provider: 'deepseek', cost_usd: 1.25 }],
      [{ provider: 'deepseek', cost_usd: 4.5 }],
    );
    const { service } = serviceWith({
      claude,
      pi,
      fetch,
      anthropicModes: [' plan ', '', 'team', 'plan'],
    });

    const result = await service.collect();

    assert.deepEqual(result.map(({ provider, freshness }) => ({ provider, freshness })), [
      { provider: 'anthropic', freshness: 'live' },
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
    const cold = serviceWith({ claude, pi: coldPi }).service;
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

  test('every explicit refresh immediately invokes every enabled source', async () => {
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

    assert.equal(claudeGetUsage.mock.calls.length, 2);
    assert.equal(piGetUsage.mock.calls.length, 2);
    assert.equal(vi.mocked(fetch).mock.calls.length, 4);
  });

  test('empty Anthropic mode configuration disables the pull and clears prior attribution', async () => {
    const claudeGetUsage = vi.fn(async () => [usage('anthropic', 'live')]);
    const piGetUsage = vi.fn(async () => [usage('openai-codex', 'never')]);
    const store = new MemoryUsageStore([usage('anthropic', 'live', {
      modes: ['plan'],
      windows: [{ type: 'five_hour', utilization: 0.4, resetsAt: null }],
    })]);
    const { service } = serviceWith({
      store,
      anthropicModes: [],
      claude: fakeAdapter('claude', claudeGetUsage),
      pi: fakeAdapter('pi', piGetUsage),
    });

    const result = await service.collect();
    const anthropic = result.find((record) => record.provider === 'anthropic');

    assert.equal(claudeGetUsage.mock.calls.length, 0);
    assert.equal(piGetUsage.mock.calls.length, 1);
    assert.deepEqual(anthropic?.modes, []);
    assert.equal(anthropic?.freshness, 'stale');
    assert.deepEqual(anthropic?.windows, [{ type: 'five_hour', utilization: 0.4, resetsAt: null }]);
    assert.match(anthropic?.note ?? '', /disabled/);
  });

  test('adapter failures preserve prior values and do not abort other providers', async () => {
    const prior = usage('anthropic', 'live', {
      displayName: 'Anthropic',
      modes: ['plan'],
      windows: [{ type: 'seven_day', utilization: 0.61, resetsAt: 1_900_000_000 }],
    });
    const store = new MemoryUsageStore([prior]);
    const claude = fakeAdapter('claude', async () => {
      throw new Error('429 usage endpoint busy');
    });
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'never')]);
    const { service } = serviceWith({ store, claude, pi });

    const result = await service.collect();
    const anthropic = result.find((record) => record.provider === 'anthropic');

    assert.deepEqual(anthropic?.windows, prior.windows);
    assert.equal(anthropic?.observedAt, prior.observedAt);
    assert.equal(anthropic?.freshness, 'stale');
    assert.match(anthropic?.note ?? '', /429 usage endpoint busy/);
    assert.equal(result.find((record) => record.provider === 'openai-codex')?.freshness, 'never');
  });

  test('a collector-declared unavailable note is persisted verbatim without a failure prefix', async () => {
    const prior = usage('anthropic', 'live', {
      displayName: 'Anthropic',
      modes: ['plan'],
      windows: [{ type: 'five_hour', utilization: 1, resetsAt: 1_900_000_000 }],
    });
    const store = new MemoryUsageStore([prior]);
    const claude = fakeAdapter('claude', async () => {
      throw new UsageUnavailableError(
        'Anthropic quota data temporarily unavailable (account rate-limited); showing last reading',
      );
    });
    const { service } = serviceWith({ store, claude });

    const result = await service.collect();
    const anthropic = result.find((record) => record.provider === 'anthropic');

    assert.deepEqual(anthropic?.windows, prior.windows);
    assert.equal(anthropic?.observedAt, prior.observedAt);
    assert.equal(anthropic?.freshness, 'stale');
    assert.equal(
      anthropic?.note,
      'Anthropic quota data temporarily unavailable (account rate-limited); showing last reading',
    );
  });

  test('a source with no observation remains never and does not throw', async () => {
    const { service } = serviceWith({
      claude: fakeAdapter('claude', async () => null),
      pi: fakeAdapter('pi', async () => null),
    });

    const result = await service.collect();
    const anthropic = result.find((record) => record.provider === 'anthropic');
    const codex = result.find((record) => record.provider === 'openai-codex');

    assert.equal(anthropic?.freshness, 'never');
    assert.match(anthropic?.note ?? '', /no observation/);
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
