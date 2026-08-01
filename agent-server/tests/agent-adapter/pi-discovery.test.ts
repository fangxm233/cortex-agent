// input:  PI exec boundary, provider scanner, fake clock
// output: PI parsing, forced refresh, and cache retry contracts
// pos:    Covers non-blocking cached PI provider discovery
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});

import {
  PI_PROVIDER_CACHE_TTL_MS,
  PI_PROVIDER_RETRY_MS,
  createPIProviderDiscovery,
  discoverPIProviders,
} from '../../src/agent-adapter/pi/discovery.js';

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

test('authenticated provider scan parses the PI table emitted on stderr', async () => {
  execFileMock.mockImplementationOnce((file, args, options, callback) => {
    callback(null, '', [
      'provider   model          context  max-out  thinking  images',
      'anthropic  claude-sonnet  200K     64K      yes       yes',
      'anthropic  claude-opus    200K     64K      yes       yes',
      'deepseek   deepseek-chat  128K     8K       no        no',
    ].join('\n'));
  });

  assert.deepEqual(await discoverPIProviders(), ['anthropic', 'deepseek']);
  const [file, args, options] = execFileMock.mock.calls[0];
  assert.equal(file, 'pi');
  assert.deepEqual(args, ['--list-models']);
  assert.equal(options.env.PI_CODING_AGENT_DIR, '');
  assert.equal(options.timeout, 10_000);
});

test('authenticated provider scan rejects when the PI command fails', async () => {
  const commandError = new Error('pi executable unavailable');
  execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
    callback(commandError, '', '');
  });

  await assert.rejects(discoverPIProviders(), commandError);
});

test('cold reads return immediately and coalesce one provider refresh', async () => {
  const pending = deferred<string[]>();
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

  pending.resolve(['anthropic']);
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['anthropic']);
  assert.equal(scans, 1, 'fresh cache does not rescan on another spawn');
});

test('explicit refresh bypasses a fresh cache', async () => {
  const results = [Promise.resolve(['anthropic']), Promise.resolve(['deepseek'])];
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
  const beforeLogin = deferred<string[]>();
  const afterLogin = deferred<string[]>();
  const results = [beforeLogin, afterLogin];
  let scans = 0;
  const discovery = createPIProviderDiscovery({ scan: () => results[scans++].promise });

  discovery.getProviders();
  await Promise.resolve();
  discovery.refresh();
  beforeLogin.resolve(['anthropic']);
  await flushRefresh();
  assert.equal(scans, 2, 'post-login refresh must run after the stale in-flight scan');

  afterLogin.resolve(['deepseek']);
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['deepseek']);
});

test('expired cache serves stale providers while one refresh deduplicates the replacement', async () => {
  let now = 1_000;
  const first = deferred<string[]>();
  const second = deferred<string[]>();
  const results = [first, second];
  let scans = 0;
  const discovery = createPIProviderDiscovery({
    now: () => now,
    scan: () => results[scans++].promise,
  });

  assert.deepEqual(discovery.getProviders(), []);
  await Promise.resolve();
  first.resolve(['anthropic']);
  await flushRefresh();

  now += PI_PROVIDER_CACHE_TTL_MS;
  assert.deepEqual(discovery.getProviders(), ['anthropic']);
  assert.deepEqual(discovery.getProviders(), ['anthropic']);
  await Promise.resolve();
  assert.equal(scans, 2, 'only one stale refresh starts');

  second.resolve(['deepseek', 'deepseek', 'openai-codex']);
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['deepseek', 'openai-codex']);
});

test('a successful empty refresh authoritatively clears stale providers', async () => {
  let now = 0;
  const results = [Promise.resolve(['anthropic']), Promise.resolve([])];
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
  const first = deferred<string[]>();
  const failed = deferred<string[]>();
  const recovered = deferred<string[]>();
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
  scenario.first.resolve(['anthropic']);
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
  scenario.recovered.resolve(['deepseek']);
  await flushRefresh();
  assert.deepEqual(scenario.discovery.getProviders(), ['deepseek']);
});
