// input:  PI exec boundary, provider scanner, fake clock
// output: PI provider parsing and cache refresh contracts
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

test('failed refresh retains last-good providers and waits for the retry interval', async () => {
  let now = 10_000;
  const first = deferred<string[]>();
  const failed = deferred<string[]>();
  const recovered = deferred<string[]>();
  const results = [first, failed, recovered];
  let scans = 0;
  const discovery = createPIProviderDiscovery({
    now: () => now,
    scan: () => results[scans++].promise,
  });

  discovery.getProviders();
  await Promise.resolve();
  first.resolve(['anthropic']);
  await flushRefresh();

  now += PI_PROVIDER_CACHE_TTL_MS;
  assert.deepEqual(discovery.getProviders(), ['anthropic']);
  await Promise.resolve();
  failed.reject(new Error('list models unavailable'));
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['anthropic']);

  now += PI_PROVIDER_RETRY_MS - 1;
  discovery.getProviders();
  await Promise.resolve();
  assert.equal(scans, 2, 'failure retry is suppressed before the retry interval');

  now += 1;
  assert.deepEqual(discovery.getProviders(), ['anthropic']);
  await Promise.resolve();
  assert.equal(scans, 3);
  recovered.resolve(['deepseek']);
  await flushRefresh();
  assert.deepEqual(discovery.getProviders(), ['deepseek']);
});
