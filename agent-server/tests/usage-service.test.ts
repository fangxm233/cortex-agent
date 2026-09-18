import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import type { AgentUsageScope, Backend } from '../src/agent-adapter/types.js';
import { Capability } from '../src/agent-adapter/capabilities.js';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import { reportCodexQuota } from '../src/agent-adapter/pi/quota-sink.js';
import {
  UsageService,
  type UsageServiceStore,
} from '../src/domain/costs/usage-service.js';
import {
  UsageStore,
  usageRecordKey,
  type ProviderUsage,
} from '../src/domain/costs/usage-store.js';

class MemoryUsageStore implements UsageServiceStore {
  private records: ProviderUsage[] = [];
  listCalls = 0;
  commitCalls = 0;

  constructor(records: ProviderUsage[] = []) {
    this.records = structuredClone(records);
  }

  async list(): Promise<ProviderUsage[]> {
    this.listCalls += 1;
    return structuredClone(this.records).sort(
      (a, b) => a.provider.localeCompare(b.provider) || usageRecordKey(a).localeCompare(usageRecordKey(b)),
    );
  }

  async commit(records: ProviderUsage[]): Promise<void> {
    this.commitCalls += 1;
    this.records = structuredClone(records);
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

/** The adapter shape the usage service reads (its dependency is structural, not a class). */
interface UsageProbeAdapter {
  backend: Backend;
  capabilities: Set<Capability>;
  getUsage: (scope: AgentUsageScope) => Promise<ProviderUsage[] | null>;
}

function fakeAdapter(
  backend: Backend,
  getUsage: UsageProbeAdapter['getUsage'],
): UsageProbeAdapter {
  return {
    backend,
    capabilities: new Set([Capability.Usage]),
    getUsage,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route A gateway: groups by provider and billing mode. */
function gatewayFetch(
  todayRows: unknown,
  monthRows: unknown,
  quotaProviders: unknown = [],
): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url.includes('/quota?')) return json({ providers: quotaProviders });
    return json({ rows: url.includes('period=today') ? todayRows : monthRows });
  }) as typeof fetch;
}

/** Route B gateway: rejects composite grouping, serves raw records instead. */
function legacyGatewayFetch(
  todayRecords: unknown[],
  monthRecords: unknown[],
  quotaProviders: unknown = [],
): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url.includes('/quota?')) return json({ providers: quotaProviders });
    if (url.includes('group_by=')) return new Response('unsupported group_by', { status: 400 });
    // The two period reads differ only by `since`; anything older than a week is the month read.
    const since = Date.parse(decodeURIComponent(new URL(url).searchParams.get('since') ?? ''));
    const isToday = Date.now() - since < 7 * 24 * 60 * 60 * 1000;
    return json({ records: isToday ? todayRecords : monthRecords });
  }) as typeof fetch;
}

function spend(provider: string, billingMode: string, costUsd: unknown) {
  return { provider, billing_mode: billingMode, cost_usd: costUsd };
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
  subscriptionModes?: string[];
  claude?: UsageProbeAdapter;
  pi?: UsageProbeAdapter;
  fetch?: typeof globalThis.fetch;
}) {
  const store = options.store ?? new MemoryUsageStore();
  const claude = options.claude ?? fakeAdapter('claude', async () => []);
  const pi = options.pi ?? fakeAdapter('pi', async () => []);
  const adapters: Record<Backend, UsageProbeAdapter> = { claude, pi };
  const service = new UsageService({
    store,
    getAdapter: (backend) => adapters[backend],
    getSettings: () => ({
      anthropicSubscriptionModes: options.anthropicModes ?? ['plan'],
      subscriptionBillingModes: options.subscriptionModes ?? ['plan', 'openai-codex'],
    }),
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
    assert.equal(store.commitCalls, 0);
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
        return json({ providers: [{
          provider: 'anthropic', mode: 'plan', observed_at: 1_786_000_000,
          windows: [
            { type: 'five_hour', utilization: 0.34, resets_at: 1_787_428_800 },
            { type: 'seven_day', utilization: 0.61, resets_at: 1_787_860_800 },
            { type: 'model_scoped', utilization: 0.99, resets_at: 1_787_860_800 },
          ],
        }] });
      }
      return json({ rows: [] });
    }) as typeof globalThis.fetch;
    const service = new UsageService({
      store,
      getAdapter,
      getSettings: () => ({
        anthropicSubscriptionModes: ['plan', 'team'],
        subscriptionBillingModes: ['plan'],
      }),
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
      billing: 'subscription',
    });
    assert.deepEqual(getAdapter.mock.calls.map(([backend]) => backend), ['pi']);
    assert.equal(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/quota?')).length, 1);
  });

  // ── dynamic discovery ────────────────────────────────────────

  test('a provider the gateway never reports gets no row at all', async () => {
    const { service } = serviceWith({ fetch: gatewayFetch([], []) });

    const providers = (await service.collect()).map((record) => record.provider);

    assert.deepEqual(providers, ['anthropic']);
    assert.ok(!providers.includes('deepseek'));
    assert.ok(!providers.includes('qwen-ksu'));
  });

  test('a provider that stops being used is dropped from the table', async () => {
    const store = new MemoryUsageStore([
      usage('qwen-ksu', 'unsupported', { billing: 'api', spend: { today: 0, month: 0 } }),
    ]);
    const { service } = serviceWith({ store, fetch: gatewayFetch([], []) });

    const providers = (await service.collect()).map((record) => record.provider);

    assert.ok(!providers.includes('qwen-ksu'));
  });

  // ── billing split ────────────────────────────────────────────

  test('subscription spend is suppressed while its quota is kept', async () => {
    const fetch = gatewayFetch(
      [spend('anthropic', 'plan', 12.5)],
      [spend('anthropic', 'plan', 91.75)],
      [{
        provider: 'anthropic', mode: 'plan', observed_at: 1_700_000_000,
        windows: [{ type: 'five_hour', utilization: 0.34, resets_at: 1_800_000_100 }],
      }],
    );
    const { service } = serviceWith({ fetch });

    const row = (await service.collect()).find((record) => record.provider === 'anthropic');

    assert.equal(row?.billing, 'subscription');
    assert.equal(row?.spend, undefined, 'plan-mode imputed price is not a bill');
    assert.deepEqual(row?.windows, [{ type: 'five_hour', utilization: 0.34, resetsAt: 1_800_000_100 }]);
  });

  test('one provider billed both ways yields a quota row and a separate metered row', async () => {
    const fetch = gatewayFetch(
      [spend('anthropic', 'plan', 12.5), spend('anthropic', 'api', 2.25)],
      [spend('anthropic', 'plan', 91.75), spend('anthropic', 'api', 8.5)],
      [{
        provider: 'anthropic', mode: 'plan', observed_at: 1_700_000_000,
        windows: [{ type: 'five_hour', utilization: 0.34, resets_at: 1_800_000_100 }],
      }],
    );
    const { service } = serviceWith({ fetch });

    const rows = (await service.collect()).filter((record) => record.provider === 'anthropic');
    const subscription = rows.find((row) => row.billing === 'subscription');
    const metered = rows.find((row) => row.billing === 'api');

    assert.equal(rows.length, 2);
    assert.equal(subscription?.spend, undefined);
    assert.equal(subscription?.windows.length, 1);
    assert.deepEqual(metered?.spend, { today: 2.25, month: 8.5 });
    assert.deepEqual(metered?.windows, []);
    assert.equal(metered?.freshness, 'unsupported');
  });

  test('genuine API-mode spend on a subscription provider is no longer discarded', async () => {
    const fetch = gatewayFetch(
      [spend('anthropic', 'api', 2.25)],
      [spend('anthropic', 'api', 8.5)],
    );
    const { service } = serviceWith({ fetch, anthropicModes: [] });

    const metered = (await service.collect())
      .find((record) => record.provider === 'anthropic' && record.billing === 'api');

    assert.deepEqual(metered?.spend, { today: 2.25, month: 8.5 });
  });

  test('settings decide which modes count as subscription', async () => {
    const rows = [spend('vendor', 'vendor-plan', 4)];
    const covered = serviceWith({
      fetch: gatewayFetch(rows, rows),
      subscriptionModes: ['vendor-plan'],
    }).service;
    const metered = serviceWith({ fetch: gatewayFetch(rows, rows), subscriptionModes: [] }).service;

    assert.equal(
      (await covered.collect()).find((record) => record.provider === 'vendor')?.spend,
      undefined,
    );
    assert.deepEqual(
      (await metered.collect()).find((record) => record.provider === 'vendor')?.spend,
      { today: 4, month: 4 },
    );
  });

  test('quota rows and spend rows survive the same collection cycle', async () => {
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'stale', {
      displayName: 'OpenAI Codex',
      modes: ['openai-codex'],
      windows: [{ type: 'codex_primary', utilization: 0.2, resetsAt: null }],
    })]);
    const fetch = gatewayFetch(
      [spend('deepseek', 'deepseek', 1.25), spend('openai-codex', 'openai-codex', 5)],
      [spend('deepseek', 'deepseek', 4.5), spend('openai-codex', 'openai-codex', 20)],
      [{
        provider: 'anthropic', mode: 'plan', observed_at: 1_700_000_000,
        windows: [{ type: 'five_hour', utilization: 0.34, resets_at: 1_800_000_100 }],
      }],
    );
    const { service } = serviceWith({ pi, fetch, anthropicModes: [' plan ', '', 'team', 'plan'] });

    const result = await service.collect();

    assert.deepEqual(result.map(({ provider, freshness }) => ({ provider, freshness })), [
      { provider: 'anthropic', freshness: 'stale' },
      { provider: 'deepseek', freshness: 'unsupported' },
      { provider: 'openai-codex', freshness: 'stale' },
    ]);
    assert.deepEqual(result.find((record) => record.provider === 'anthropic')?.modes, ['plan', 'team']);
    assert.deepEqual(result.find((record) => record.provider === 'deepseek')?.spend, {
      today: 1.25,
      month: 4.5,
    });
    const codex = result.find((record) => record.provider === 'openai-codex');
    assert.equal(codex?.windows.length, 1, 'quota survived the spend write');
    assert.equal(codex?.spend, undefined, 'codex plan traffic is not billed');
  });

  // ── transport routes ─────────────────────────────────────────

  test('a gateway without composite grouping falls back to raw records once and stays there', async () => {
    const fetch = legacyGatewayFetch(
      [
        { provider: 'deepseek', billing_mode: 'deepseek', cost: 0.75 },
        { provider: 'deepseek', billing_mode: 'deepseek', cost: 0.5 },
        { provider: 'anthropic', billing_mode: 'plan', cost: 9 },
      ],
      [
        { provider: 'deepseek', billing_mode: 'deepseek', cost: 4 },
        { provider: 'anthropic', billing_mode: 'plan', cost: 40 },
      ],
    );
    const { service } = serviceWith({ fetch });

    const first = await service.collect();
    assert.deepEqual(first.find((record) => record.provider === 'deepseek')?.spend, {
      today: 1.25,
      month: 4,
    });
    assert.equal(
      first.find((record) => record.provider === 'anthropic')?.spend,
      undefined,
      'records route still honours the billing split',
    );

    const groupedAttempts = () => vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input).includes('group_by=')).length;
    const afterFirst = groupedAttempts();
    await service.collect();

    assert.equal(afterFirst, 2, 'both periods probe the composite route once');
    assert.equal(groupedAttempts(), 2, 'the unsupported route is not probed again');
  });

  test('truncated record pages are flagged rather than reported as a total', async () => {
    const many = Array.from({ length: 20_000 }, () => ({
      provider: 'deepseek', billing_mode: 'deepseek', cost: 0.001,
    }));
    const fetch = legacyGatewayFetch(many, many);
    const { service } = serviceWith({ fetch });

    const row = (await service.collect()).find((record) => record.provider === 'deepseek');

    assert.match(row?.note ?? '', /truncated/);
  });

  // ── resilience ───────────────────────────────────────────────

  test('a cached PI collection snapshot cannot overwrite a newer quota push', async () => {
    const store = durableMemoryStore();
    await store.update(usage('openai-codex', 'stale', {
      modes: ['openai-codex'],
      windows: [{ type: 'codex_primary', utilization: 0.1, resetsAt: null }],
      observedAt: 100,
      billing: 'subscription',
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
      getSettings: () => ({ anthropicSubscriptionModes: [], subscriptionBillingModes: ['plan'] }),
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
      billing: 'subscription',
      windows: [{ type: 'five_hour', utilization: 0.4, resetsAt: null }],
    })]);
    const fetch = gatewayFetch([spend('anthropic', 'plan', 1)], [spend('anthropic', 'plan', 1)]);
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
    assert.deepEqual(anthropic?.modes, ['plan']);
    assert.match(anthropic?.note ?? '', /disabled/);
  });

  test('gateway quota failures preserve prior values and do not abort other providers', async () => {
    const prior = usage('anthropic', 'live', {
      displayName: 'Anthropic',
      modes: ['plan'],
      billing: 'subscription',
      windows: [
        { type: 'seven_day', utilization: 0.61, resetsAt: 1_900_000_000 },
        { type: 'model_scoped', label: 'Fable', utilization: 0.8, resetsAt: 1_900_000_000 },
      ],
    });
    const store = new MemoryUsageStore([prior]);
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'never')]);
    const fetch = vi.fn(async (input) => {
      if (String(input).includes('/quota?')) throw new Error('gateway offline');
      return json({ rows: [] });
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
      displayName: 'Anthropic', modes: ['plan'], billing: 'subscription',
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

    assert.equal(anthropic?.freshness, 'never');
    assert.match(anthropic?.note ?? '', /no Anthropic quota observation/);
    assert.equal(
      result.find((record) => record.provider === 'openai-codex'),
      undefined,
      'an unused Codex account is not invented',
    );
  });

  test('a malformed provider cost does not discard a valid sibling provider', async () => {
    const store = new MemoryUsageStore([
      usage('deepseek', 'unsupported', {
        displayName: 'DeepSeek',
        modes: ['deepseek'],
        billing: 'api',
        spend: { today: 3, month: 8 },
      }),
    ]);
    const fetch = gatewayFetch(
      [spend('deepseek', 'deepseek', 'bad'), spend('qwen', 'qwen', 2.5)],
      [spend('deepseek', 'deepseek', 9), spend('qwen', 'qwen', 7.5)],
    );
    const { service } = serviceWith({ store, fetch });

    const result = await service.collect();

    assert.deepEqual(result.find((record) => record.provider === 'deepseek')?.spend, {
      today: 3,
      month: 9,
    });
    assert.match(result.find((record) => record.provider === 'deepseek')?.note ?? '', /today/);
    assert.deepEqual(result.find((record) => record.provider === 'qwen')?.spend, {
      today: 2.5,
      month: 7.5,
    });
    assert.equal(result.find((record) => record.provider === 'qwen')?.note, undefined);
  });

  test.each([
    ['gateway error', async () => { throw new Error('gateway offline'); }],
    ['429 response', async () => new Response('busy', { status: 429 })],
    ['timeout', async () => { throw new Error('request timed out'); }],
    ['parse failure', async () => json({ rows: 'invalid provider rows' })],
  ])('%s preserves prior spend rather than deleting the row', async (_name, fetchImpl) => {
    const store = new MemoryUsageStore([
      usage('deepseek', 'unsupported', {
        displayName: 'DeepSeek', modes: ['deepseek'], billing: 'api',
        spend: { today: 3, month: 8 },
      }),
      usage('qwen', 'unsupported', {
        displayName: 'Qwen', modes: ['qwen'], billing: 'api',
        spend: { today: 2, month: 7 },
      }),
    ]);
    const { service } = serviceWith({
      store,
      fetch: vi.fn(fetchImpl) as typeof globalThis.fetch,
    });

    const result = await service.refresh();

    for (const provider of ['deepseek', 'qwen']) {
      const record = result.find((candidate) => candidate.provider === provider);
      assert.equal(record?.freshness, 'unsupported');
      assert.deepEqual(record?.spend, provider === 'deepseek'
        ? { today: 3, month: 8 }
        : { today: 2, month: 7 });
      assert.ok(record?.note);
    }
  });
});
