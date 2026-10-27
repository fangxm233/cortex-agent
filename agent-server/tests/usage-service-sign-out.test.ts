import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { UsageService } from '../src/domain/costs/usage-service.js';
import { usageRecordKey, type ProviderUsage } from '../src/domain/costs/usage-store.js';
import type { AccountReading } from '../src/domain/costs/reset-account.js';
import { MemoryUsageStore, usage, fakeAdapter, gatewayFetch, spend } from './usage-service-fixtures.js';

const SIGN_OUT_MS = 1_790_000_000_000;
const OBSERVED_BEFORE = 1_789_900_000;

const keys = (rows: ProviderUsage[]) => rows.map(usageRecordKey).sort();

function signOutService(options: {
  store: MemoryUsageStore;
  subscriptionModes?: string[];
  claude?: () => Promise<AccountReading | null>;
  codexObserved?: ProviderUsage[];
}) {
  let nowMs = SIGN_OUT_MS;
  const spendRows = [spend('anthropic', 'plan', 3), spend('anthropic', 'api', 1.5), spend('github', 'copilot', 2)];
  const service = new UsageService({
    store: options.store,
    getAdapter: () => fakeAdapter('pi', async () => options.codexObserved ?? []),
    getSettings: () => ({
      anthropicSubscriptionModes: ['plan'],
      subscriptionBillingModes: options.subscriptionModes ?? ['plan', 'copilot', 'openai-codex'],
    }),
    fetch: gatewayFetch(spendRows, spendRows, [{
      provider: 'anthropic', mode: 'plan', observed_at: OBSERVED_BEFORE,
      windows: [{ type: 'five_hour', utilization: 0.5, resets_at: 1_790_010_000 }],
    }]),
    gatewayUrl: 'http://gateway.test',
    now: () => new Date(nowMs),
    claudeAccount: { readUsage: options.claude ?? (async () => null) },
  });
  return { service, advance: (ms: number) => { nowMs += ms; } };
}

describe('UsageService subscription sign-out', () => {
  const anthropicPlan = usage('anthropic', 'stale', {
    billing: 'subscription', modes: ['plan'], observedAt: OBSERVED_BEFORE,
    windows: [{ type: 'five_hour', utilization: 0.9, resetsAt: 1_790_010_000 }],
  });
  const anthropicApi = usage('anthropic', 'unsupported', {
    billing: 'api', modes: ['api'], spend: { today: 1.5, month: 1.5 },
  });

  test('a signed-out subscription stays hidden from stale readings while metered rows remain', async () => {
    const store = new MemoryUsageStore([anthropicPlan, anthropicApi]);
    const { service } = signOutService({ store });

    await service.signOut('anthropic');

    assert.deepEqual(keys(await service.getStatus()), ['anthropic::api']);
    assert.deepEqual(keys(await store.list()), ['anthropic::api'], 'the stored row goes with the sign-out');
    const collected = await service.collect();
    assert.equal(collected.some((row) => row.provider === 'anthropic' && row.billing === 'subscription'), false,
      'neither the gateway observation nor subscription spend brings it back');
    assert.ok(collected.some((row) => usageRecordKey(row) === 'anthropic::api'));
  });

  test('a reading taken after the sign-out shows the subscription again', async () => {
    let reading: AccountReading | null = null;
    const store = new MemoryUsageStore([anthropicPlan]);
    const { service, advance } = signOutService({ store, claude: async () => reading });
    await service.signOut('anthropic');

    advance(60_000);
    reading = { windows: [{ type: 'five_hour', utilization: 0.1, resetsAt: 1_790_018_000 }], resetCredits: null };
    const row = (await service.collect()).find((record) => usageRecordKey(record) === 'anthropic::subscription');

    assert.equal(row?.freshness, 'live');
    assert.equal(row?.observedAt, SIGN_OUT_MS / 1000 + 60);
  });

  test('signing in again restores a subscription row that never carries a quota reading', async () => {
    const store = new MemoryUsageStore();
    const { service } = signOutService({ store });
    const copilot = (rows: ProviderUsage[]) => rows.some((row) => usageRecordKey(row) === 'github::subscription');
    assert.ok(copilot(await service.collect()));

    await service.signOut('github');
    assert.equal(copilot(await service.collect()), false);

    await service.signIn('github');
    assert.ok(copilot(await service.collect()));
  });

  test('a signed-out Codex row is not rebuilt from response headers seen before it', async () => {
    const observed = usage('openai-codex', 'stale', {
      billing: 'subscription', modes: ['openai-codex'], observedAt: OBSERVED_BEFORE,
      windows: [{ type: 'codex_primary', utilization: 0.4, resetsAt: 1_790_100_000 }],
    });
    const store = new MemoryUsageStore([observed]);
    const { service } = signOutService({ store, codexObserved: [observed] });

    await service.signOut('openai-codex');

    assert.equal((await service.collect()).some((row) => row.provider === 'openai-codex'), false);
  });
});
