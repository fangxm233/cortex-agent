import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { CostEntry } from '../src/domain/costs/cost-tracker.js';
import { UsageService, type UsageServiceDependencies } from '../src/domain/costs/usage-service.js';
import { usageRecordKey, type ProviderUsage } from '../src/domain/costs/usage-store.js';
import {
  NOW, billingTable, claudeKeyRow, daysAgo, durableMemoryStore, fakeAdapter, hoursAgo, ledgerRow, usage,
} from './usage-service-fixtures.js';

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
/** `ledger`: the spend read fails. `account`: the Claude account read fails. */
const OUTAGES = ['none', 'ledger', 'account'] as const;
type Outage = typeof OUTAGES[number];

function outage(kind: Outage, ledger: CostEntry[] = []): UsageServiceDependencies {
  return {
    readLedger: kind === 'ledger' ? async () => { throw new Error('ledger unreadable'); } : async () => ledger,
    claudeAccount: { readUsage: kind === 'account' ? async () => { throw new Error('account unavailable'); } : async () => null },
  };
}

async function discovery(prior: ProviderUsage[] = [], dependencies: UsageServiceDependencies = {}) {
  const store = durableMemoryStore();
  for (const row of prior) await store.update(row);
  const service = new UsageService({
    store,
    getAdapter: () => fakeAdapter('pi', async () => []),
    readLedger: async () => [],
    billingOf: billingTable(),
    now: () => NOW,
    ...dependencies,
  });
  return { service, store };
}

function anthropicSubscription(rows: ProviderUsage[]) {
  return rows.find((row) => usageRecordKey(row) === 'anthropic::subscription');
}

describe('Anthropic usage evidence', () => {
  test.each(OUTAGES)('Codex alone never creates Anthropic (outage: %s)', async (kind) => {
    const { service } = await discovery([], {
      ...outage(kind), getAdapter: () => fakeAdapter('pi', async () => [CODEX]),
    });

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['openai-codex::subscription']);
    assert.deepEqual(rows[0].windows, CODEX.windows);
  });

  test.each(OUTAGES)('no traffic and no reading creates no providers (outage: %s)', async (kind) => {
    const { service, store } = await discovery([], outage(kind));

    assert.deepEqual(await service.refresh(), []);
    assert.deepEqual(await store.list(), []);
  });

  describe.each(['subscription', undefined] as const)('old placeholder billing: %s', (billing) => {
    test.each(OUTAGES)('refresh deletes it durably (outage: %s)', async (kind) => {
      const { service, store } = await discovery([{ ...EMPTY, billing }], outage(kind));

      assert.deepEqual(await service.refresh(), []);
      assert.deepEqual(await store.list(), []);
      assert.deepEqual(await service.refresh(), [], 'a later refresh must not resurrect the placeholder');
    });
  });

  test.each([{ prior: [] }, { prior: [EMPTY] }])('current subscription traffic without quota survives (prior: %j)', async ({ prior }) => {
    const { service } = await discovery(prior, outage('none', [ledgerRow(hoursAgo(1), { cost_usd: 0 })]));

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['anthropic::subscription']);
    assert.equal(rows[0].freshness, 'never');
    assert.deepEqual(rows[0].windows, []);
    assert.deepEqual(rows[0].modes, ['subscription']);
    assert.equal(rows[0].spend, undefined);
  });

  test('a Claude reading creates the row without traffic or history', async () => {
    const { service } = await discovery([], {
      claudeAccount: { readUsage: async () => ({ windows: WINDOWS, resetCredits: RESETS }) },
    });

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['anthropic::subscription']);
    assert.deepEqual(rows[0].windows, WINDOWS);
    assert.equal(rows[0].freshness, 'live');
  });

  test.each(OUTAGES)('real history survives absent readings (outage: %s)', async (kind) => {
    const prior = { ...EMPTY, windows: WINDOWS, observedAt: 1_800_000_000, freshness: 'live' as const,
      resetCredits: RESETS };
    const { service, store } = await discovery([prior], {
      ...outage(kind),
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
    const { service } = await discovery([{ ...EMPTY, ...history }], outage('account'));

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

  test.each(['none', 'ledger'] as const)('an empty placeholder cannot mask legacy quota history (outage: %s)', async (kind) => {
    const legacy = { ...EMPTY, billing: undefined, windows: WINDOWS, observedAt: 1_800_000_000 };
    const { service } = await discovery([EMPTY, legacy], outage(kind));

    const row = anthropicSubscription(await service.refresh());

    assert.deepEqual(row?.windows, WINDOWS);
    assert.equal(row?.observedAt, legacy.observedAt);
    assert.equal(row?.freshness, 'stale');
  });

  test.each(['none', 'ledger'] as const)('API spend is neither deleted nor subscription evidence (outage: %s)', async (kind) => {
    const api = usage('anthropic', 'unsupported', {
      billing: 'api', modes: ['api'], spend: { today: 2, month: 8, all: 20 },
    });
    const ledger = [
      claudeKeyRow(hoursAgo(1), 'api', 2), claudeKeyRow(daysAgo(10), 'api', 6), claudeKeyRow(daysAgo(40), 'api', 12),
    ];
    const { service, store } = await discovery([EMPTY, api], outage(kind, ledger));

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['anthropic::api']);
    assert.deepEqual(rows[0].spend, api.spend);
    assert.deepEqual(rows[0].modes, ['api']);
    assert.equal(rows[0].freshness, 'unsupported');
    assert.deepEqual(await store.list(), rows);
  });

  test('an API observation timestamp does not count as subscription quota history', async () => {
    const api = { ...EMPTY, billing: 'api' as const, observedAt: 1_800_000_000 };
    const { service } = await discovery([api], outage('ledger'));

    assert.deepEqual((await service.refresh()).map(usageRecordKey), ['anthropic::api']);
  });

  test('legacy spend is preserved on failure without inventing a subscription row', async () => {
    const legacy = { ...EMPTY, billing: undefined, spend: { today: 0, month: 0 } };
    const { service } = await discovery([legacy], outage('ledger'));

    const rows = await service.refresh();

    assert.deepEqual(rows.map(usageRecordKey), ['anthropic']);
    assert.deepEqual(rows[0].spend, legacy.spend);
  });
});
