import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { UsageService, type UsageServiceDependencies } from '../src/domain/costs/usage-service.js';
import { usageRecordKey, type ProviderUsage } from '../src/domain/costs/usage-store.js';
import { durableMemoryStore, fakeAdapter, gatewayFetch, json, spend, usage } from './usage-service-fixtures.js';

const WINDOWS = [{ type: 'five_hour', utilization: 0, resetsAt: 1_900_000_000 }];
const RESETS = { availableCount: 1, credits: [{ id: 'reset-1', title: 'Reset', expiresAt: null }] };
const EMPTY = usage('anthropic', 'never', {
  displayName: 'Anthropic', billing: 'subscription', modes: ['plan'],
  note: 'no Anthropic quota observation',
});
const CODEX = usage('openai-codex', 'stale', {
  displayName: 'OpenAI Codex', billing: 'subscription',
  windows: [{ type: 'codex_primary', utilization: 0.2, resetsAt: null }],
});
const OUTAGES = ['none', 'all', 'today', 'month', 'quota'] as const;
type Outage = typeof OUTAGES[number];

function outageFetch(outage: Outage): typeof fetch {
  return async (input) => {
    const url = String(input);
    const fails = outage === 'all' || url.includes(`period=${outage}`)
      || (outage === 'quota' && url.includes('/quota?'));
    if (fails) throw new Error('gateway offline');
    return url.includes('/quota?') ? json({ providers: [] }) : json({ rows: [] });
  };
}

async function discovery(prior: ProviderUsage[] = [], dependencies: UsageServiceDependencies = {}) {
  const store = durableMemoryStore();
  for (const row of prior) await store.update(row);
  const service = new UsageService({
    store,
    getAdapter: () => fakeAdapter('pi', async () => []),
    getSettings: () => ({
      anthropicSubscriptionModes: ['plan'], subscriptionBillingModes: ['plan', 'openai-codex'],
    }),
    fetch: gatewayFetch([], []),
    gatewayUrl: 'http://gateway.test',
    ...dependencies,
  });
  return { service, store };
}

function anthropicSubscription(rows: ProviderUsage[]) {
  return rows.find((row) => usageRecordKey(row) === 'anthropic::subscription');
}

describe('Anthropic usage evidence', () => {
  test.each(OUTAGES)('Codex alone never creates Anthropic (gateway outage: %s)', async (outage) => {
    const { service } = await discovery([], {
      fetch: outageFetch(outage), getAdapter: () => fakeAdapter('pi', async () => [CODEX]),
    });

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['openai-codex::subscription']);
    assert.deepEqual(rows[0].windows, CODEX.windows);
  });

  test.each(OUTAGES)('default plan mode alone creates no providers (gateway outage: %s)', async (outage) => {
    const { service, store } = await discovery([], { fetch: outageFetch(outage) });

    assert.deepEqual(await service.refresh(), []);
    assert.deepEqual(await store.list(), []);
  });

  describe.each(['subscription', undefined] as const)('old placeholder billing: %s', (billing) => {
    test.each(OUTAGES)('refresh deletes it durably (gateway outage: %s)', async (outage) => {
      const { service, store } = await discovery([{ ...EMPTY, billing }], { fetch: outageFetch(outage) });

      assert.deepEqual(await service.refresh(), []);
      assert.deepEqual(await store.list(), []);
      assert.deepEqual(await service.refresh(), [], 'a later refresh must not resurrect the placeholder');
    });
  });

  test('disabled quota polling cannot restore an old placeholder during an outage', async () => {
    const { service, store } = await discovery([EMPTY], {
      fetch: outageFetch('all'),
      getSettings: () => ({ anthropicSubscriptionModes: [], subscriptionBillingModes: ['plan'] }),
    });

    assert.deepEqual(await service.refresh(), []);
    assert.deepEqual(await store.list(), []);
  });

  test.each([{ prior: [] }, { prior: [EMPTY] }])('current subscription traffic without quota survives (prior: %j)', async ({ prior }) => {
    const { service } = await discovery(prior, {
      fetch: gatewayFetch([], [spend('anthropic', 'plan', 0)]),
    });

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['anthropic::subscription']);
    assert.equal(rows[0].freshness, 'never');
    assert.deepEqual(rows[0].windows, []);
    assert.equal(rows[0].spend, undefined);
    assert.match(rows[0].note ?? '', /no Anthropic quota observation/);
  });

  test.each(['gateway', 'Claude'])('%s quota creates a row without traffic or history', async (source) => {
    const dependencies: UsageServiceDependencies = source === 'Claude'
      ? { claudeAccount: { readUsage: async () => ({ windows: WINDOWS, resetCredits: RESETS }) } }
      : { fetch: gatewayFetch([], [], [{
        provider: 'anthropic', observed_at: 1_800_000_000,
        windows: WINDOWS.map(({ resetsAt, ...window }) => ({ ...window, resets_at: resetsAt })),
      }]) };
    const { service } = await discovery([], dependencies);

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['anthropic::subscription']);
    assert.deepEqual(rows[0].windows, WINDOWS);
    assert.equal(rows[0].freshness, source === 'Claude' ? 'live' : 'stale');
  });

  test.each(OUTAGES)('real history survives absent readings (gateway outage: %s)', async (outage) => {
    const prior = { ...EMPTY, windows: WINDOWS, observedAt: 1_800_000_000, freshness: 'live' as const,
      resetCredits: RESETS };
    const { service, store } = await discovery([prior], {
      fetch: outageFetch(outage),
      claudeAccount: { readUsage: async () => { throw new Error('account unavailable'); } },
    });

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['anthropic::subscription']);
    assert.deepEqual(rows[0].windows, WINDOWS);
    assert.equal(rows[0].observedAt, prior.observedAt);
    assert.equal(rows[0].freshness, 'stale');
    assert.deepEqual(rows[0].resetCredits, RESETS);
    assert.deepEqual(await store.list(), rows);
  });

  test.each([
    { windows: WINDOWS }, { observedAt: 1_800_000_000 }, { resetCredits: RESETS },
  ])('partial quota history is not an empty placeholder: %j', async (history) => {
    const { service } = await discovery([{ ...EMPTY, ...history }], {
      fetch: outageFetch('all'),
      claudeAccount: { readUsage: async () => { throw new Error('account unavailable'); } },
    });

    const row = anthropicSubscription(await service.refresh());

    assert.ok(row);
    for (const [key, value] of Object.entries(history)) {
      assert.deepEqual(row[key as keyof ProviderUsage], value);
    }
  });

  test('legacy quota history remains evidence without billing attribution', async () => {
    const { service } = await discovery([{ ...EMPTY, billing: undefined, windows: WINDOWS }]);

    assert.deepEqual(anthropicSubscription(await service.refresh())?.windows, WINDOWS);
  });

  test.each(['none', 'all'] as const)('an empty placeholder cannot mask legacy quota history (outage: %s)', async (outage) => {
    const legacy = { ...EMPTY, billing: undefined, windows: WINDOWS, observedAt: 1_800_000_000 };
    const { service } = await discovery([EMPTY, legacy], { fetch: outageFetch(outage) });

    const row = anthropicSubscription(await service.refresh());

    assert.deepEqual(row?.windows, WINDOWS);
    assert.equal(row?.observedAt, legacy.observedAt);
    assert.equal(row?.freshness, 'stale');
  });

  test.each(['none', 'all', 'today', 'month'] as const)('API spend is neither deleted nor subscription evidence (gateway outage: %s)', async (outage) => {
    const api = usage('anthropic', 'unsupported', {
      billing: 'api', modes: ['api'], spend: { today: 2, month: 8, all: 20 },
    });
    const fetch = outage === 'none'
      ? gatewayFetch([spend('anthropic', 'api', 2)], [spend('anthropic', 'api', 8)], [],
        [spend('anthropic', 'api', 20)])
      : outageFetch(outage);
    const { service, store } = await discovery([EMPTY, api], { fetch });

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['anthropic::api']);
    assert.deepEqual(rows[0].spend, api.spend);
    assert.equal(rows[0].freshness, 'unsupported');
    assert.deepEqual(await store.list(), rows);
  });

  test('an API observation timestamp does not count as subscription quota history', async () => {
    const api = { ...EMPTY, billing: 'api' as const, observedAt: 1_800_000_000 };
    const { service } = await discovery([api], { fetch: outageFetch('all') });

    assert.deepEqual((await service.refresh()).map(usageRecordKey), ['anthropic::api']);
  });

  test('legacy spend is preserved on failure without inventing a subscription row', async () => {
    const legacy = { ...EMPTY, billing: undefined, spend: { today: 0, month: 0 } };
    const { service } = await discovery([legacy], { fetch: outageFetch('all') });

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['anthropic']);
    assert.deepEqual(rows[0].spend, legacy.spend);
  });
});
