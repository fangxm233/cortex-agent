import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import { reportCodexQuota } from '../src/agent-adapter/pi/quota-sink.js';
import { UsageService } from '../src/domain/costs/usage-service.js';
import { usageRecordKey, type ProviderUsage } from '../src/domain/costs/usage-store.js';
import {
  MemoryUsageStore, usage, fakeAdapter, json, gatewayFetch, legacyGatewayFetch,
  spend, deferred, durableMemoryStore, serviceWith,
} from './usage-service-fixtures.js';

describe('UsageService', () => {
  test('status is a side-effect-free read that hides legacy Anthropic model-scoped rows', async () => {
    const persisted = usage('anthropic', 'stale', { windows: [
      { type: 'five_hour', utilization: 0.2, resetsAt: 1_800_000_000 },
      { type: 'model_scoped', label: 'Fable', utilization: 0.9, resetsAt: 1_800_000_000 },
    ] });
    const store = new MemoryUsageStore([persisted]);
    const pi = fakeAdapter('pi', vi.fn(async () => []));
    const fetch = vi.fn();
    const { service } = serviceWith({ store, pi, fetch: fetch as typeof globalThis.fetch });

    assert.deepEqual(await service.getStatus(), [{ ...persisted, windows: [persisted.windows[0]] }]);
    assert.equal(store.commitCalls, 0);
    assert.equal(pi.getUsage && vi.mocked(pi.getUsage).mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
  });

  test('collect reads Anthropic quota from the gateway', async () => {
    const store = new MemoryUsageStore();
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'never', {
      displayName: 'OpenAI Codex', modes: ['openai-codex'],
    })]);
    const getAdapter = vi.fn(() => pi);
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
    assert.equal(getAdapter.mock.calls.length, 1);
    assert.equal(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/quota?')).length, 1);
  });

  // ── dynamic discovery ────────────────────────────────────────

  test('a provider the gateway never reports gets no row at all', async () => {
    const { service } = serviceWith({ fetch: gatewayFetch([], []) });

    const providers = (await service.collect()).map((record) => record.provider);

    assert.deepEqual(providers, []);
    assert.ok(!providers.includes('deepseek'));
    assert.ok(!providers.includes('qwen-local'));
  });

  test('a provider that stops being used is dropped from the table', async () => {
    const store = new MemoryUsageStore([
      usage('qwen-local', 'unsupported', { billing: 'api', spend: { today: 0, month: 0 } }),
    ]);
    const { service } = serviceWith({ store, fetch: gatewayFetch([], []) });

    const providers = (await service.collect()).map((record) => record.provider);

    assert.ok(!providers.includes('qwen-local'));
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

  test.each(['grouped', 'records'])('%s normalizes only OpenAI Codex spend attribution', async (route) => {
    const today = [spend('openai', 'openai-codex', 12.5), spend('openai', 'api', 2.25),
      spend('vendor', 'openai-codex', 3)];
    const month = [spend('openai', 'openai-codex', 91.75), spend('openai', 'api', 8.5),
      spend('vendor', 'openai-codex', 9)];
    const records = (rows: typeof today) => rows.map(({ cost_usd, ...row }) => ({ ...row, cost: cost_usd }));
    const fetch = route === 'grouped'
      ? gatewayFetch(today, month)
      : legacyGatewayFetch(records(today), records(month));
    const { service } = serviceWith({ fetch, anthropicModes: [] });

    const result = await service.collect();

    assert.deepEqual(result.map(usageRecordKey), ['openai::api', 'openai-codex::subscription', 'vendor::subscription']);
    const codex = result.find((row) => row.provider === 'openai-codex');
    assert.equal(codex?.displayName, 'OpenAI Codex');
    assert.deepEqual(codex?.modes, ['openai-codex']);
    assert.equal(codex?.spend, undefined);
    const api = result.find((row) => row.provider === 'openai');
    assert.deepEqual(api?.modes, ['api']);
    assert.deepEqual(api?.spend, { today: 2.25, month: 8.5 });
  });

  test('healthy refresh removes persisted empty OpenAI subscription and retains Codex quota', async () => {
    const store = durableMemoryStore();
    await store.update(usage('openai', 'unsupported', {
      billing: 'subscription', modes: ['openai-codex'],
    }));
    const quota = usage('openai-codex', 'stale', {
      displayName: 'OpenAI Codex', billing: 'subscription',
      windows: [{ type: 'codex_primary', utilization: 0.2, resetsAt: null }],
    });
    await store.update(quota);
    const service = new UsageService({
      store,
      getAdapter: () => fakeAdapter('pi', async () => [quota]),
      getSettings: () => ({ anthropicSubscriptionModes: [], subscriptionBillingModes: ['openai-codex'] }),
      fetch: gatewayFetch([spend('openai', 'openai-codex', 5)], [spend('openai', 'openai-codex', 20)]),
      gatewayUrl: 'http://gateway.test',
    });
    assert.ok(await store.get('openai', 'subscription'));

    const result = await service.refresh();

    assert.equal(await store.get('openai', 'subscription'), null);
    assert.deepEqual(await store.list(), [quota]);
    assert.deepEqual(result, [quota]);
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

  test('an OAuth sign-in makes its provider mode a subscription', async () => {
    const rows = [spend('openai', 'openai', 3)];
    const service = (oauth: string[]) => new UsageService({
      store: new MemoryUsageStore(),
      getAdapter: () => fakeAdapter('pi', async () => []),
      getSettings: () => ({ anthropicSubscriptionModes: [], subscriptionBillingModes: ['plan'] }),
      getOAuthProviders: () => new Set(oauth),
      fetch: gatewayFetch(rows, rows),
      gatewayUrl: 'http://gateway.test',
    });

    const signedIn = (await service(['openai']).collect()).find((record) => record.provider === 'openai');
    const keyed = (await service([]).collect()).find((record) => record.provider === 'openai');

    assert.equal(signedIn?.billing, 'subscription');
    assert.equal(signedIn?.spend, undefined);
    assert.equal(keyed?.billing, 'api');
    assert.deepEqual(keyed?.spend, { today: 3, month: 3 });
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
    }, 'the records route reports no lifetime total');
    assert.equal(
      first.find((record) => record.provider === 'anthropic')?.spend,
      undefined,
      'records route still honours the billing split',
    );

    const groupedAttempts = () => vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input).includes('group_by=')).length;
    const afterFirst = groupedAttempts();
    await service.collect();

    assert.equal(afterFirst, 3, 'both periods and the lifetime total probe the composite route once');
    assert.equal(groupedAttempts(), 3, 'the unsupported route is not probed again');
  });

  test('the lifetime total enriches recent metered rows without reviving idle providers', async () => {
    const fetch = gatewayFetch(
      [spend('deepseek', 'deepseek', 1)],
      [spend('deepseek', 'deepseek', 4), spend('anthropic', 'plan', 40)],
      [],
      [
        spend('deepseek', 'deepseek', 30),
        spend('deepseek', 'deepseek-alt', 20),
        spend('anthropic', 'plan', 400),
        spend('qwen', 'qwen', 3),
      ],
    );
    const { service } = serviceWith({ fetch });

    const result = await service.collect();

    const deepseek = result.find((record) => record.provider === 'deepseek');
    assert.deepEqual(deepseek?.spend, { today: 1, month: 4, all: 50 });
    assert.deepEqual(deepseek?.modes, ['deepseek'], 'lifetime rows do not add modes');
    assert.equal(result.find((record) => record.provider === 'qwen'), undefined);
    assert.equal(result.find((record) => record.provider === 'anthropic')?.spend, undefined);
  });

  test('a failed lifetime read keeps the stored total', async () => {
    const store = new MemoryUsageStore([
      usage('deepseek', 'unsupported', {
        modes: ['deepseek'], billing: 'api', spend: { today: 1, month: 4, all: 42 },
      }),
    ]);
    const fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/quota?')) return json({ providers: [] });
      if (url.includes('period=all')) return new Response('boom', { status: 500 });
      return json({ rows: [spend('deepseek', 'deepseek', url.includes('period=today') ? 2 : 6)] });
    }) as typeof globalThis.fetch;
    const { service } = serviceWith({ store, fetch });

    const deepseek = (await service.collect()).find((record) => record.provider === 'deepseek');

    assert.deepEqual(deepseek?.spend, { today: 2, month: 6, all: 42 });
    assert.equal(deepseek?.note, undefined);
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
    const service = new UsageService({
      store,
      getAdapter: () => pi,
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
    const piGetUsage = vi.fn(async () => [usage('openai-codex', 'never')]);
    const fetch = gatewayFetch([], []);
    const { service } = serviceWith({
      pi: fakeAdapter('pi', piGetUsage),
      fetch,
    });

    await service.refresh();
    await service.refresh();

    assert.equal(piGetUsage.mock.calls.length, 2);
    assert.equal(vi.mocked(fetch).mock.calls.length, 8);
    assert.equal(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/quota?')).length, 2);
  });

  test('empty Anthropic mode configuration disables gateway quota reads and clears attribution', async () => {
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
      pi: fakeAdapter('pi', piGetUsage),
      fetch,
    });

    const result = await service.collect();
    const anthropic = result.find((record) => record.provider === 'anthropic');

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

  test('sources with no observations do not invent provider rows or throw', async () => {
    const { service } = serviceWith({
      pi: fakeAdapter('pi', async () => null),
    });

    const result = await service.collect();
    assert.deepEqual(result, []);
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

describe('UsageService active Codex account reads', () => {
  const NOW = new Date(1_790_000_000_000);
  const RESETS = {
    availableCount: 1,
    credits: [{ id: 'credit-1', title: 'Full reset', expiresAt: 1_792_600_000 }],
  };
  const observed = usage('openai-codex', 'stale', {
    displayName: 'OpenAI Codex', billing: 'subscription', observedAt: 1_789_990_000,
    windows: [{ type: 'codex_primary', utilization: 0.99, resetsAt: 1_792_115_610 }],
  });

  function codexService(options: {
    store: MemoryUsageStore;
    readUsage: () => Promise<import('../src/domain/costs/codex-account.js').CodexAccountUsage | null>;
    releaseThrottle?: (provider: string, windows: unknown[]) => Promise<unknown>;
  }) {
    return new UsageService({
      store: options.store,
      // Like the PI adapter: the observed row is whatever the store last recorded for Codex.
      getAdapter: () => fakeAdapter('pi', async () => (await options.store.list())
        .filter((record) => record.provider === 'openai-codex')),
      getSettings: () => ({ anthropicSubscriptionModes: [], subscriptionBillingModes: ['openai-codex'] }),
      fetch: gatewayFetch([], []),
      gatewayUrl: 'http://gateway.test',
      now: () => NOW,
      codexAccount: { readUsage: options.readUsage },
      releaseThrottle: options.releaseThrottle,
    });
  }

  test('a live account reading replaces the observed row and releases recovered throttle windows', async () => {
    const store = new MemoryUsageStore([observed]);
    const windows = [{ type: 'codex_primary', utilization: 0, resetsAt: 1_790_018_000 }];
    const releaseThrottle = vi.fn(async () => true);
    const service = codexService({
      store, releaseThrottle, readUsage: async () => ({ planType: 'prolite', windows, resetCredits: RESETS }),
    });

    const [row] = await service.refresh();

    assert.deepEqual(row, {
      provider: 'openai-codex', displayName: 'OpenAI Codex', modes: ['openai-codex'],
      windows, observedAt: NOW.getTime() / 1000, freshness: 'live', billing: 'subscription',
      resetCredits: RESETS,
    });
    assert.deepEqual(releaseThrottle.mock.calls, [['openai-codex', windows]]);
  });

  test('a failed account read degrades to the observed row with a note and keeps known reset credits', async () => {
    const store = new MemoryUsageStore([{ ...observed, resetCredits: RESETS }]);
    const service = codexService({ store, readUsage: async () => { throw new Error('HTTP 503'); } });

    const [row] = await service.refresh();

    assert.deepEqual(row.windows, observed.windows);
    assert.equal(row.freshness, 'stale');
    assert.match(row.note ?? '', /account read failed.*HTTP 503/);
    assert.deepEqual(row.resetCredits, RESETS);
  });

  test('without a Codex sign-in stored reset credits are dropped', async () => {
    const store = new MemoryUsageStore([{ ...observed, resetCredits: RESETS }]);
    const service = codexService({ store, readUsage: async () => null });

    const [row] = await service.refresh();

    assert.deepEqual(row.windows, observed.windows);
    assert.equal(row.resetCredits, undefined);
    assert.equal(row.note, undefined);
  });

  test('a throttle release failure does not cost the reading', async () => {
    const store = new MemoryUsageStore([observed]);
    const windows = [{ type: 'codex_primary', utilization: 0.1, resetsAt: 1_790_018_000 }];
    const service = codexService({
      store,
      readUsage: async () => ({ planType: null, windows, resetCredits: null }),
      releaseThrottle: async () => { throw new Error('persist failed'); },
    });

    const [row] = await service.refresh();

    assert.equal(row.freshness, 'live');
    assert.deepEqual(row.windows, windows);
  });
});

describe('UsageService active Claude account reads', () => {
  const NOW = new Date(1_790_000_000_000);
  const RESETS = {
    availableCount: 1,
    atLimit: true,
    credits: [{ id: 'grant_1', title: 'Reset', expiresAt: 1_792_600_000, clears: ['five_hour', 'seven_day'] }],
  };
  const GATEWAY_WINDOWS = [
    { type: 'five_hour', utilization: 0.5, resetsAt: 1_790_010_000 },
    { type: 'seven_day', utilization: 0.2, resetsAt: 1_790_500_000 },
  ];
  const prior = usage('anthropic', 'stale', {
    displayName: 'Anthropic', modes: ['plan'], billing: 'subscription', observedAt: 1_789_000_000,
    windows: [{ type: 'five_hour', utilization: 0.9, resetsAt: 1_789_010_000 }], resetCredits: RESETS,
  });

  function gatewayQuota(): typeof globalThis.fetch {
    return gatewayFetch([], [], [{
      provider: 'anthropic', mode: 'plan', observed_at: 1_789_900_000,
      windows: GATEWAY_WINDOWS.map(({ resetsAt, ...window }) => ({ ...window, resets_at: resetsAt })),
    }]);
  }

  function claudeService(options: {
    readUsage: () => Promise<import('../src/domain/costs/reset-account.js').AccountReading | null>;
    store?: MemoryUsageStore;
    fetch?: typeof globalThis.fetch;
    releaseThrottle?: (provider: string, windows: unknown[]) => Promise<unknown>;
  }) {
    const store = options.store ?? new MemoryUsageStore([prior]);
    const fetch = options.fetch ?? gatewayQuota();
    const service = new UsageService({
      store,
      getAdapter: () => fakeAdapter('pi', async () => []),
      getSettings: () => ({ anthropicSubscriptionModes: ['plan'], subscriptionBillingModes: ['plan'] }),
      fetch,
      gatewayUrl: 'http://gateway.test',
      now: () => NOW,
      claudeAccount: { readUsage: options.readUsage },
      releaseThrottle: options.releaseThrottle ?? (async () => false),
    });
    return { service, fetch };
  }

  const anthropicRow = (rows: ProviderUsage[]) => rows.find((row) => row.provider === 'anthropic');
  const quotaReads = (fetch: typeof globalThis.fetch) => vi.mocked(fetch).mock.calls
    .filter(([input]) => String(input).includes('/quota?')).length;

  test('a live account reading fills the row, carries its resets and only releases the Anthropic throttle', async () => {
    const windows = [
      { type: 'five_hour', utilization: 0.12, resetsAt: 1_790_018_000 },
      { type: 'seven_day', utilization: 0.4, resetsAt: null },
    ];
    const releaseThrottle = vi.fn(async () => true);
    const { service, fetch } = claudeService({ releaseThrottle, readUsage: async () => ({ windows, resetCredits: RESETS }) });

    const row = anthropicRow(await service.refresh());

    assert.deepEqual(row?.windows, windows);
    assert.equal(row?.observedAt, NOW.getTime() / 1000);
    assert.equal(row?.freshness, 'live');
    assert.deepEqual((await service.getStatus()).find((record) => record.provider === 'anthropic')?.freshness, 'live');
    assert.deepEqual(row?.resetCredits, RESETS);
    assert.equal(row?.note, undefined);
    assert.deepEqual(releaseThrottle.mock.calls, [['anthropic', windows]]);
    assert.equal(quotaReads(fetch), 0, 'the gateway is only the fallback');
  });

  test('a failed account read falls back to the gateway with a note and keeps known resets', async () => {
    const { service, fetch } = claudeService({ readUsage: async () => { throw new Error('HTTP 429'); } });

    const row = anthropicRow(await service.refresh());

    assert.deepEqual(row?.windows, GATEWAY_WINDOWS);
    assert.equal(row?.observedAt, 1_789_900_000);
    assert.equal(row?.freshness, 'stale', 'a gateway observation is never live');
    assert.match(row?.note ?? '', /Claude account read failed.*HTTP 429/);
    assert.deepEqual(row?.resetCredits, RESETS);
    assert.equal(quotaReads(fetch), 1);
  });

  test('without a Claude login the gateway fills the row and stored resets are dropped', async () => {
    const releaseThrottle = vi.fn(async () => true);
    const { service } = claudeService({ releaseThrottle, readUsage: async () => null });

    const row = anthropicRow(await service.refresh());

    assert.deepEqual(row?.windows, GATEWAY_WINDOWS);
    assert.equal(row?.resetCredits, undefined);
    assert.equal(row?.note, undefined);
    assert.equal(releaseThrottle.mock.calls.length, 0, 'a gateway observation never touches the throttle');
  });

  test('when both sources fail the last windows and resets survive', async () => {
    const fetch = vi.fn(async (input) => (
      String(input).includes('/quota?') ? json({}, 502) : json({ rows: [] })
    )) as unknown as typeof globalThis.fetch;
    const store = new MemoryUsageStore([{ ...prior, freshness: 'live' }]);
    const { service } = claudeService({ store, fetch, readUsage: async () => { throw new Error('timeout'); } });

    const row = anthropicRow(await service.refresh());

    assert.deepEqual(row?.windows, prior.windows);
    assert.equal(row?.freshness, 'stale', 'a carried-over live reading ages to stale');
    assert.deepEqual(row?.resetCredits, RESETS);
    assert.match(row?.note ?? '', /Claude account read failed.*timeout/);
    assert.match(row?.note ?? '', /HTTP 502/);
  });
});
