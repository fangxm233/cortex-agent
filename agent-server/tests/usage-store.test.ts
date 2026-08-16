// input:  Vitest, ProviderStateRepo, usage-store model and API
// output: usage defaults, persistence, replacement, and legacy regressions
// pos:    Validates the durable provider usage source
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { ProviderStateRepo } from '../src/store/provider-state-repo.js';
import {
  UsageStore,
  type ProviderUsage,
} from '../src/domain/costs/usage-store.js';

let tmpDir: string;
let testIndex = 0;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-usage-store-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function nextFile(): string {
  return path.join(tmpDir, String(testIndex++), 'provider-state.json');
}

function usage(
  provider: string,
  freshness: ProviderUsage['freshness'] = 'live',
  utilization = 0.12,
): ProviderUsage {
  return {
    provider,
    displayName: provider.toUpperCase(),
    modes: ['plan'],
    windows: [{
      type: 'iguana_necktie',
      label: 'Unlisted window',
      utilization,
      resetsAt: 2_000,
    }],
    observedAt: freshness === 'never' || freshness === 'unsupported' ? null : 1_000,
    freshness,
  };
}

function storeFor(repo: ProviderStateRepo): UsageStore {
  return new UsageStore({
    load: () => repo.getProviderUsage(),
    save: (records) => repo.setProviderUsage(records),
  });
}

test('usage persistence defaults to an empty provider list', async () => {
  const repo = new ProviderStateRepo(nextFile());
  const store = storeFor(repo);

  assert.deepEqual(await repo.getProviderUsage(), []);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get('missing'), null);
});

test('all freshness states and arbitrary windows round-trip below the throttle threshold', async () => {
  const filePath = nextFile();
  const first = storeFor(new ProviderStateRepo(filePath));
  const records = [
    usage('live-provider', 'live', 0),
    usage('stale-provider', 'stale', 0.01),
    usage('never-provider', 'never', 0.12),
    usage('unsupported-provider', 'unsupported', 0.5),
  ];

  await first.replace(records);
  const restarted = storeFor(new ProviderStateRepo(filePath));

  assert.deepEqual(
    await restarted.list(),
    [...records].sort((a, b) => a.provider.localeCompare(b.provider)),
  );
});

test('update atomically upserts by provider and returns defensive copies', async () => {
  const store = storeFor(new ProviderStateRepo(nextFile()));
  const alpha = usage('alpha');
  await Promise.all([
    store.update(alpha),
    store.update(usage('beta', 'stale', 0.02)),
  ]);

  alpha.windows[0].utilization = 0.99;
  const firstRead = await store.get('alpha');
  assert.equal(firstRead?.windows[0].utilization, 0.12);
  firstRead!.modes.push('mutated');

  const replacement = usage('alpha', 'live', 0.03);
  replacement.note = 'newest reading';
  await store.update(replacement);

  assert.deepEqual((await store.list()).map((record) => record.provider), ['alpha', 'beta']);
  assert.deepEqual(await store.get('alpha'), replacement);
  assert.deepEqual((await store.get('alpha'))?.modes, ['plan']);
});

test('replace removes omitted providers and deterministically keeps the last duplicate', async () => {
  const store = storeFor(new ProviderStateRepo(nextFile()));
  await store.replace([usage('beta'), usage('alpha')]);

  const newestAlpha = usage('alpha', 'stale', 0.04);
  await store.replace([usage('gamma'), usage('alpha', 'live', 0.01), newestAlpha]);

  assert.deepEqual((await store.list()).map((record) => record.provider), ['alpha', 'gamma']);
  assert.deepEqual(await store.get('alpha'), newestAlpha);
  assert.equal(await store.get('beta'), null);
});

test('usage writes preserve legacy throttle and resume state without a usage field', async () => {
  const filePath = nextFile();
  const legacy = {
    rateLimitThrottle: {
      resetsAt: 3_000,
      activatedAt: 2_000,
      modes: ['plan'],
      types: ['five_hour'],
    },
    resumeQueue: [{
      kind: 'direct',
      channel: 'channel-a',
      userMessage: 'continue',
      recordedAt: 1_000,
    }],
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(legacy));
  const repo = new ProviderStateRepo(filePath);

  assert.deepEqual(await repo.getProviderUsage(), []);
  await storeFor(repo).update(usage('alpha', 'stale', 0.02));

  assert.deepEqual(await repo.getRateLimitThrottle(), legacy.rateLimitThrottle);
  assert.deepEqual(await repo.getResumeQueue(), legacy.resumeQueue);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    ...legacy,
    providerUsage: [usage('alpha', 'stale', 0.02)],
  });
});
