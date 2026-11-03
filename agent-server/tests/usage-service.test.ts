import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import { reportCodexQuota } from '../src/agent-adapter/pi/quota-sink.js';
import { usageRecordKey, type ProviderUsage } from '../src/domain/costs/usage-store.js';
import {
  MemoryUsageStore, NOW, billingTable, claudeKeyRow, daysAgo, deferred, durableMemoryStore,
  fakeAdapter, hoursAgo, ledgerRow, piRow, serviceWith, usage,
} from './usage-service-fixtures.js';

const anthropicRow = (rows: ProviderUsage[], billing: 'subscription' | 'api' = 'subscription') =>
  rows.find((row) => row.provider === 'anthropic' && row.billing === billing);

describe('UsageService spend', () => {
  test('status is a side-effect-free read that hides legacy Anthropic model-scoped rows', async () => {
    const persisted = usage('anthropic', 'stale', { windows: [
      { type: 'five_hour', utilization: 0.2, resetsAt: 1_800_000_000 },
      { type: 'model_scoped', label: 'Fable', utilization: 0.9, resetsAt: 1_800_000_000 },
    ] });
    const store = new MemoryUsageStore([persisted]);
    const pi = fakeAdapter('pi', vi.fn(async () => []));
    const readLedger = vi.fn(async () => []);
    const { service } = serviceWith({ store, pi, readLedger });

    assert.deepEqual(await service.getStatus(), [{ ...persisted, windows: [persisted.windows[0]] }]);
    assert.equal(store.commitCalls, 0);
    assert.equal(vi.mocked(pi.getUsage).mock.calls.length, 0);
    assert.equal(readLedger.mock.calls.length, 0);
  });

  test('ledger traffic decides the rows: metered spend shows, subscription spend does not', async () => {
    const ledger = [
      ledgerRow(hoursAgo(1), { cost_usd: 12.5 }),
      claudeKeyRow(hoursAgo(2), 'my-relay', 2.25),
      claudeKeyRow(daysAgo(10), 'relay', 6.25),
      piRow(hoursAgo(3), 'openai-codex', 20),
      piRow(hoursAgo(3), 'deepseek', 1.25),
      piRow(daysAgo(50), 'deepseek', 10),
    ];
    const { service } = serviceWith({ ledger });

    const result = await service.collect();

    assert.deepEqual(result.map(usageRecordKey), [
      'anthropic::api', 'anthropic::subscription', 'deepseek::api', 'openai-codex::subscription',
    ]);
    assert.deepEqual(anthropicRow(result), {
      provider: 'anthropic', displayName: 'Anthropic', modes: ['subscription'], windows: [],
      observedAt: null, freshness: 'never', billing: 'subscription',
    }, 'a subscription\'s imputed price is not a bill; its quota has no reading yet');
    const metered = anthropicRow(result, 'api');
    assert.deepEqual(metered?.modes, ['my-relay', 'relay']);
    assert.deepEqual(metered?.spend, { today: 2.25, month: 8.5, all: 8.5 });
    assert.equal(metered?.freshness, 'unsupported');
    assert.deepEqual(result.find((row) => row.provider === 'deepseek')?.spend, { today: 1.25, month: 1.25, all: 11.25 });
    const codex = result.find((row) => row.provider === 'openai-codex');
    assert.equal(codex?.displayName, 'OpenAI Codex');
    assert.equal(codex?.spend, undefined);
  });

  test('a connection\'s billing, not its name, decides whether its spend is a bill', async () => {
    const ledger = [claudeKeyRow(hoursAgo(1), 'team', 4)];
    const covered = serviceWith({ ledger, billingOf: billingTable(['claude:team']) }).service;
    const metered = serviceWith({ ledger }).service;

    assert.equal(anthropicRow(await covered.collect())?.spend, undefined);
    assert.deepEqual(anthropicRow(await metered.collect(), 'api')?.spend, { today: 4, month: 4, all: 4 });
  });

  test('a provider without traffic gets no row, and one that stops being used is dropped', async () => {
    const store = new MemoryUsageStore([
      usage('qwen-local', 'unsupported', { billing: 'api', spend: { today: 0, month: 0 } }),
    ]);
    const { service } = serviceWith({ store, ledger: [piRow(daysAgo(40), 'qwen-local', 3)] });

    assert.deepEqual(await service.collect(), []);
  });

  test('a healthy refresh removes a persisted gateway-era OpenAI subscription and keeps Codex quota', async () => {
    const store = durableMemoryStore();
    await store.update(usage('openai', 'unsupported', { billing: 'subscription', modes: ['openai-codex'] }));
    const quota = usage('openai-codex', 'stale', {
      displayName: 'OpenAI Codex', billing: 'subscription',
      windows: [{ type: 'codex_primary', utilization: 0.2, resetsAt: null }],
    });
    await store.update(quota);
    const { service } = serviceWith({
      store, pi: fakeAdapter('pi', async () => [quota]), ledger: [piRow(hoursAgo(1), 'openai-codex', 5)],
    });

    const result = await service.refresh();

    assert.equal(await store.get('openai', 'subscription'), null);
    assert.deepEqual(result, [{ ...quota, modes: ['openai-codex'] }]);
  });

  test('quota rows and spend rows survive the same collection cycle', async () => {
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'stale', {
      displayName: 'OpenAI Codex', modes: ['openai-codex'],
      windows: [{ type: 'codex_primary', utilization: 0.2, resetsAt: null }],
    })]);
    const { service } = serviceWith({
      pi, ledger: [piRow(hoursAgo(1), 'deepseek', 1.25), piRow(hoursAgo(1), 'openai-codex', 5)],
    });

    const result = await service.collect();

    assert.deepEqual(result.map(({ provider, freshness }) => ({ provider, freshness })), [
      { provider: 'deepseek', freshness: 'unsupported' },
      { provider: 'openai-codex', freshness: 'stale' },
    ]);
    const codex = result.find((record) => record.provider === 'openai-codex');
    assert.equal(codex?.windows.length, 1, 'quota survived the spend write');
    assert.equal(codex?.spend, undefined, 'codex subscription traffic is not billed');
  });

  test('every explicit refresh reads the ledger and each quota source once', async () => {
    const piGetUsage = vi.fn(async () => [usage('openai-codex', 'never')]);
    const readLedger = vi.fn(async () => []);
    const readUsage = vi.fn(async () => null);
    const { service } = serviceWith({ pi: fakeAdapter('pi', piGetUsage), readLedger, claudeAccount: { readUsage } });

    await service.refresh();
    await service.refresh();

    assert.equal(piGetUsage.mock.calls.length, 2);
    assert.equal(readLedger.mock.calls.length, 2);
    assert.equal(readUsage.mock.calls.length, 2);
  });

  test('sources with no observations do not invent provider rows or throw', async () => {
    const { service } = serviceWith({ pi: fakeAdapter('pi', async () => null) });

    assert.deepEqual(await service.collect(), []);
  });

  test('an unreadable ledger keeps prior spend rows instead of deleting them', async () => {
    const store = new MemoryUsageStore([
      usage('deepseek', 'unsupported', { displayName: 'DeepSeek', modes: ['deepseek'], billing: 'api', spend: { today: 3, month: 8, all: 9 } }),
      usage('qwen', 'unsupported', { displayName: 'Qwen', modes: ['qwen'], billing: 'api', spend: { today: 2, month: 7 } }),
    ]);
    const pi = fakeAdapter('pi', async () => [usage('openai-codex', 'never')]);
    const { service } = serviceWith({ store, pi, readLedger: async () => { throw new Error('EACCES'); } });

    const result = await service.refresh();

    assert.deepEqual(result.find((row) => row.provider === 'deepseek')?.spend, { today: 3, month: 8, all: 9 });
    assert.deepEqual(result.find((row) => row.provider === 'qwen')?.spend, { today: 2, month: 7 });
    for (const row of result) assert.match(row.note ?? '', /EACCES/);
    assert.equal(result.find((row) => row.provider === 'openai-codex')?.freshness, 'never', 'other sources still answer');
  });

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
    const { service } = serviceWith({ store, pi: pi as never });

    const collection = service.collect();
    await snapshotRead.promise;
    await reportCodexQuota(
      { provider: 'openai-codex', planType: 'pro', windows: [{ type: 'codex_primary', utilization: 0.9, resetsAt: null }] },
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
});

describe('UsageService active Codex account reads', () => {
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
    return serviceWith({
      store: options.store,
      // Like the PI adapter: the observed row is whatever the store last recorded for Codex.
      pi: fakeAdapter('pi', async () => (await options.store.list())
        .filter((record) => record.provider === 'openai-codex')),
      codexAccount: { readUsage: options.readUsage },
      releaseThrottle: options.releaseThrottle,
    }).service;
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
      windows, observedAt: Math.floor(NOW.getTime() / 1000), freshness: 'live', billing: 'subscription',
      resetCredits: RESETS,
    });
    assert.deepEqual(releaseThrottle.mock.calls, [['openai-codex', windows, 'openai-codex']]);
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
  const RESETS = {
    availableCount: 1,
    atLimit: true,
    credits: [{ id: 'grant_1', title: 'Reset', expiresAt: 1_792_600_000, clears: ['five_hour', 'seven_day'] }],
  };
  const prior = usage('anthropic', 'stale', {
    displayName: 'Anthropic', modes: ['subscription'], billing: 'subscription', observedAt: 1_789_000_000,
    windows: [{ type: 'five_hour', utilization: 0.9, resetsAt: 1_789_010_000 }], resetCredits: RESETS,
  });

  function claudeService(options: {
    readUsage: () => Promise<import('../src/domain/costs/reset-account.js').AccountReading | null>;
    store?: MemoryUsageStore;
    releaseThrottle?: (provider: string, windows: unknown[]) => Promise<unknown>;
  }) {
    return serviceWith({
      store: options.store ?? new MemoryUsageStore([prior]),
      claudeAccount: { readUsage: options.readUsage },
      releaseThrottle: options.releaseThrottle ?? (async () => false),
    }).service;
  }

  test('a live account reading fills the row, carries its resets and only releases the Anthropic throttle', async () => {
    const windows = [
      { type: 'five_hour', utilization: 0.12, resetsAt: 1_790_018_000 },
      { type: 'seven_day', utilization: 0.4, resetsAt: null },
    ];
    const releaseThrottle = vi.fn(async () => true);
    const service = claudeService({ releaseThrottle, readUsage: async () => ({ windows, resetCredits: RESETS }) });

    const row = anthropicRow(await service.refresh());

    assert.deepEqual(row, {
      provider: 'anthropic', displayName: 'Anthropic', modes: ['subscription'], windows,
      observedAt: Math.floor(NOW.getTime() / 1000), freshness: 'live', billing: 'subscription',
      resetCredits: RESETS,
    });
    assert.equal(anthropicRow(await service.getStatus())?.freshness, 'live');
    assert.deepEqual(releaseThrottle.mock.calls, [['anthropic', windows, 'subscription']]);
  });

  test('a reading creates the row without traffic or history; model-scoped windows stay internal', async () => {
    const windows = [
      { type: 'five_hour', utilization: 0.3, resetsAt: 1_790_018_000 },
      { type: 'model_scoped', label: 'Fable', utilization: 0.99, resetsAt: 1_790_018_000 },
    ];
    const service = claudeService({ store: new MemoryUsageStore(), readUsage: async () => ({ windows, resetCredits: null }) });

    const row = anthropicRow(await service.refresh());

    assert.deepEqual(row?.windows, [windows[0]]);
  });

  test('a failed account read keeps the last windows and resets, aged, with a note', async () => {
    const store = new MemoryUsageStore([{ ...prior, freshness: 'live' }]);
    const service = claudeService({ store, readUsage: async () => { throw new Error('HTTP 429'); } });

    const row = anthropicRow(await service.refresh());

    assert.deepEqual(row?.windows, prior.windows);
    assert.equal(row?.observedAt, prior.observedAt);
    assert.equal(row?.freshness, 'stale', 'a carried-over live reading ages to stale');
    assert.deepEqual(row?.resetCredits, RESETS);
    assert.match(row?.note ?? '', /Claude account read failed.*HTTP 429/);
  });

  test('without a Claude login the last windows stay and stored resets are dropped', async () => {
    const releaseThrottle = vi.fn(async () => true);
    const service = claudeService({ releaseThrottle, readUsage: async () => null });

    const row = anthropicRow(await service.refresh());

    assert.deepEqual(row?.windows, prior.windows);
    assert.equal(row?.freshness, 'stale');
    assert.equal(row?.resetCredits, undefined);
    assert.equal(row?.note, undefined);
    assert.equal(releaseThrottle.mock.calls.length, 0);
  });
});
