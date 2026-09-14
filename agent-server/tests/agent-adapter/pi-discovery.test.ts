import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  PI_PROVIDER_CACHE_TTL_MS,
  PI_PROVIDER_RETRY_MS,
  createPIProviderDiscovery,
  discoverPIProviders,
} from '../../src/agent-adapter/pi/discovery.js';
import type { PiDiscoveredModel } from '../../src/core/gateway-generator.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushRefresh(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('authenticated provider scan de-duplicates providers from the SDK model list', async () => {
  const providers = await discoverPIProviders(async () => [
    { provider: 'anthropic', model: 'claude-sonnet' },
    { provider: 'anthropic', model: 'claude-opus' },
    { provider: 'deepseek', model: 'deepseek-chat' },
  ]);
  assert.deepEqual(providers, ['anthropic', 'deepseek']);
});

test('authenticated provider scan rejects when the SDK scan fails', async () => {
  const scanError = new Error('pi runtime unavailable');
  await assert.rejects(discoverPIProviders(async () => { throw scanError; }), scanError);
});

test('cold reads return immediately and coalesce one provider refresh', async () => {
  const pending = deferred<PiDiscoveredModel[]>();
  let scans = 0;
  const discovery = createPIProviderDiscovery({
    scan: () => {
      scans += 1;
      return pending.promise;
    },
  });

  assert.deepEqual(discovery.getProviders(), []);
  assert.deepEqual(discovery.getProviders(), []);
  await Promise.resolve();
  assert.equal(scans, 1);

  pending.resolve([{ provider: 'anthropic', model: 'claude-sonnet' }]);
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['anthropic']);
  assert.equal(scans, 1, 'fresh cache does not rescan on another spawn');
});

test('explicit refresh bypasses a fresh cache', async () => {
  const results = [
    Promise.resolve([{ provider: 'anthropic', model: 'claude-sonnet' }]),
    Promise.resolve([{ provider: 'deepseek', model: 'deepseek-chat' }]),
  ];
  let scans = 0;
  const discovery = createPIProviderDiscovery({ scan: () => results[scans++] });

  discovery.getProviders();
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['anthropic']);

  discovery.refresh();
  await flushRefresh();
  assert.equal(scans, 2);
  assert.deepEqual(discovery.getProviders(), ['deepseek']);
});

test('explicit refresh queues a post-login scan behind an in-flight scan', async () => {
  const beforeLogin = deferred<PiDiscoveredModel[]>();
  const afterLogin = deferred<PiDiscoveredModel[]>();
  const results = [beforeLogin, afterLogin];
  let scans = 0;
  const discovery = createPIProviderDiscovery({ scan: () => results[scans++].promise });

  discovery.getProviders();
  await Promise.resolve();
  discovery.refresh();
  beforeLogin.resolve([{ provider: 'anthropic', model: 'claude-sonnet' }]);
  await flushRefresh();
  assert.equal(scans, 2, 'post-login refresh must run after the stale in-flight scan');

  afterLogin.resolve([{ provider: 'deepseek', model: 'deepseek-chat' }]);
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['deepseek']);
});

test('expired cache serves stale providers while one refresh deduplicates the replacement', async () => {
  let now = 1_000;
  const first = deferred<PiDiscoveredModel[]>();
  const second = deferred<PiDiscoveredModel[]>();
  const results = [first, second];
  let scans = 0;
  const discovery = createPIProviderDiscovery({
    now: () => now,
    scan: () => results[scans++].promise,
  });

  assert.deepEqual(discovery.getProviders(), []);
  await Promise.resolve();
  first.resolve([{ provider: 'anthropic', model: 'claude-sonnet' }]);
  await flushRefresh();

  now += PI_PROVIDER_CACHE_TTL_MS;
  assert.deepEqual(discovery.getProviders(), ['anthropic']);
  assert.deepEqual(discovery.getProviders(), ['anthropic']);
  await Promise.resolve();
  assert.equal(scans, 2, 'only one stale refresh starts');

  second.resolve([
    { provider: 'deepseek', model: 'deepseek-chat' },
    { provider: 'deepseek', model: 'deepseek-chat' },
    { provider: 'openai-codex', model: 'gpt-5' },
  ]);
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['deepseek', 'openai-codex']);
});

test('a successful empty refresh authoritatively clears stale providers', async () => {
  let now = 0;
  const results: Array<Promise<PiDiscoveredModel[]>> = [
    Promise.resolve([{ provider: 'anthropic', model: 'claude-sonnet' }]),
    Promise.resolve([]),
  ];
  let scans = 0;
  const discovery = createPIProviderDiscovery({
    now: () => now,
    scan: () => results[scans++],
  });

  discovery.getProviders();
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['anthropic']);

  now += PI_PROVIDER_CACHE_TTL_MS;
  assert.deepEqual(discovery.getProviders(), ['anthropic']);
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), []);
});

function retryScenario() {
  const clock = { now: 10_000 };
  const scans = { count: 0 };
  const first = deferred<PiDiscoveredModel[]>();
  const failed = deferred<PiDiscoveredModel[]>();
  const recovered = deferred<PiDiscoveredModel[]>();
  const results = [first, failed, recovered];
  const discovery = createPIProviderDiscovery({
    now: () => clock.now,
    scan: () => results[scans.count++].promise,
  });
  return { clock, scans, first, failed, recovered, discovery };
}

test('failed refresh retains last-good providers and waits for the retry interval', async () => {
  const scenario = retryScenario();
  scenario.discovery.getProviders();
  await Promise.resolve();
  scenario.first.resolve([{ provider: 'anthropic', model: 'claude-sonnet' }]);
  await flushRefresh();

  scenario.clock.now += PI_PROVIDER_CACHE_TTL_MS;
  assert.deepEqual(scenario.discovery.getProviders(), ['anthropic']);
  await Promise.resolve();
  scenario.failed.reject(new Error('list models unavailable'));
  await flushRefresh();
  assert.deepEqual(scenario.discovery.getProviders(), ['anthropic']);

  scenario.clock.now += PI_PROVIDER_RETRY_MS - 1;
  scenario.discovery.getProviders();
  await Promise.resolve();
  assert.equal(scenario.scans.count, 2, 'retry is suppressed before the retry interval');

  scenario.clock.now += 1;
  scenario.discovery.getProviders();
  await Promise.resolve();
  assert.equal(scenario.scans.count, 3);
  scenario.recovered.resolve([{ provider: 'deepseek', model: 'deepseek-chat' }]);
  await flushRefresh();
  assert.deepEqual(scenario.discovery.getProviders(), ['deepseek']);
});

test('models cache de-duplicates repeated provider/model pairs', async () => {
  const discovery = createPIProviderDiscovery({
    scan: () => Promise.resolve([
      { provider: 'anthropic', model: 'claude-sonnet' },
      { provider: 'anthropic', model: 'claude-sonnet' },
      { provider: 'anthropic', model: 'claude-opus' },
      { provider: 'deepseek', model: 'deepseek-chat' },
    ]),
  });

  assert.deepEqual(discovery.getModels(), []);
  await flushRefresh();
  assert.deepEqual(discovery.getModels(), [
    { provider: 'anthropic', model: 'claude-sonnet' },
    { provider: 'anthropic', model: 'claude-opus' },
    { provider: 'deepseek', model: 'deepseek-chat' },
  ]);

  const copy = discovery.getModels();
  copy.push({ provider: 'added', model: 'locally' });
  assert.equal(discovery.getModels().length, 3, 'getModels returns a defensive copy');
});

test('expired cache serves the stale model snapshot while one refresh is in flight', async () => {
  let now = 1_000;
  const first = deferred<PiDiscoveredModel[]>();
  const second = deferred<PiDiscoveredModel[]>();
  const results = [first, second];
  let scans = 0;
  const discovery = createPIProviderDiscovery({
    now: () => now,
    scan: () => results[scans++].promise,
  });

  assert.deepEqual(discovery.getModels(), []);
  await Promise.resolve();
  first.resolve([{ provider: 'anthropic', model: 'claude-sonnet' }]);
  await flushRefresh();

  now += PI_PROVIDER_CACHE_TTL_MS;
  assert.deepEqual(discovery.getModels(), [{ provider: 'anthropic', model: 'claude-sonnet' }]);
  assert.deepEqual(discovery.getModels(), [{ provider: 'anthropic', model: 'claude-sonnet' }]);
  await Promise.resolve();
  assert.equal(scans, 2, 'only one stale refresh starts');

  second.resolve([{ provider: 'deepseek', model: 'deepseek-chat' }]);
  await flushRefresh();
  assert.deepEqual(discovery.getModels(), [{ provider: 'deepseek', model: 'deepseek-chat' }]);
});
