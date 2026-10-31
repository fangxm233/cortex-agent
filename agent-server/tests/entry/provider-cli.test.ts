import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';

import { runProviderCli } from '../../src/entry/provider-cli.js';
import type { CustomProviderStores } from '../../src/domain/pi-providers/index.js';

function tmpStores(): CustomProviderStores & { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-provider-cli-'));
  return { dir, connectionsPath: path.join(dir, 'connections.json') };
}

/** The PI connections the CLI stored, keyed by provider name. */
function storedProviders(stores: CustomProviderStores): Record<string, any> {
  const { connections } = JSON.parse(fs.readFileSync(stores.connectionsPath, 'utf8'));
  return Object.fromEntries(connections.filter((entry: any) => entry.backend === 'pi').map((entry: any) => [entry.id, entry]));
}

const ADD_ARGS = [
  'add', '--name', 'my-vllm', '--api', 'anthropic-messages',
  '--url', 'http://127.0.0.1:8100', '--key', 'upstream-secret', '--model', 'Model-27B',
];

test('provider CLI: add stores the connection and reports the stored provider as JSON', () => {
  const stores = tmpStores();
  try {
    const result = runProviderCli([...ADD_ARGS, '--json'], stores);
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.provider.name, 'my-vllm');
    assert.equal(payload.provider.upstreamUrl, 'http://127.0.0.1:8100');
    assert.equal(payload.provider.hasApiKey, true);
    assert.equal(payload.provider.routed, true);
    assert.equal(payload.provider.apiKey, undefined, 'the CLI never echoes the key back');

    const stored = storedProviders(stores)['my-vllm'];
    assert.equal(stored.baseUrl, 'http://127.0.0.1:8100', 'PI calls the provider at its own URL');
    assert.equal(stored.key, 'upstream-secret');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('provider CLI: add accepts repeated --model flags and reads the key from stdin', () => {
  const stores = tmpStores();
  try {
    const result = runProviderCli(
      ['add', '--name', 'my-proxy', '--api', 'openai-completions', '--url', 'https://proxy.example.com/v1',
        '--key', '-', '--model', 'small', '--model', 'large', '--json'],
      stores,
      { readSecret: () => 'piped-secret\n' },
    );
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.provider.models.map((m: { id: string }) => m.id), ['small', 'large']);
    const stored = storedProviders(stores)['my-proxy'];
    assert.equal(stored.key, 'piped-secret', 'the piped secret is trimmed');
    assert.equal(stored.api, 'openai-completions');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('provider CLI: add is an upsert, so a retry updates instead of duplicating', () => {
  const stores = tmpStores();
  try {
    runProviderCli(ADD_ARGS, stores);
    const result = runProviderCli(
      ['add', '--name', 'my-vllm', '--api', 'anthropic-messages', '--url', 'http://127.0.0.1:8200',
        '--model', 'Model-27B', '--json'],
      stores,
    );
    assert.equal(result.exitCode, 0);
    const providers = storedProviders(stores);
    assert.deepEqual(Object.keys(providers), ['my-vllm']);
    assert.equal(providers['my-vllm'].baseUrl, 'http://127.0.0.1:8200');
    assert.equal(providers['my-vllm'].key, 'upstream-secret', 'an omitted key keeps the stored one');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('provider CLI: add rejects a missing flag and an invalid api with a fix path', () => {
  const stores = tmpStores();
  try {
    const missing = runProviderCli(['add', '--api', 'anthropic-messages', '--url', 'http://x'], stores);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /--name/);

    const badApi = runProviderCli(
      ['add', '--name', 'x', '--api', 'ollama', '--url', 'http://x', '--model', 'm'],
      stores,
    );
    assert.equal(badApi.exitCode, 1);
    assert.match(badApi.stderr, /anthropic-messages/);
    assert.equal(fs.existsSync(stores.connectionsPath), false, 'a rejected add writes nothing');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('provider CLI: list reports stored providers and stays empty-safe', () => {
  const stores = tmpStores();
  try {
    const empty = runProviderCli(['list', '--json'], stores);
    assert.equal(empty.exitCode, 0);
    assert.deepEqual(JSON.parse(empty.stdout).providers, []);

    runProviderCli(ADD_ARGS, stores);
    const listed = runProviderCli(['list', '--json'], stores);
    const [provider] = JSON.parse(listed.stdout).providers;
    assert.equal(provider.name, 'my-vllm');
    assert.equal(provider.hasApiKey, true);

    const text = runProviderCli(['list'], stores);
    assert.match(text.stdout, /my-vllm/);
    assert.ok(!text.stdout.includes('upstream-secret'), 'the key is never printed');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('provider CLI: remove --dry-run reports the target without deleting it', () => {
  const stores = tmpStores();
  try {
    runProviderCli(ADD_ARGS, stores);
    const result = runProviderCli(['remove', '--name', 'my-vllm', '--dry-run', '--json'], stores);
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dry_run, true);
    assert.equal(payload.would_remove.name, 'my-vllm');
    assert.ok(storedProviders(stores)['my-vllm'], 'dry run leaves the provider in place');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('provider CLI: remove deletes the provider and reports an unknown name', () => {
  const stores = tmpStores();
  try {
    runProviderCli(ADD_ARGS, stores);
    const removed = runProviderCli(['remove', '--name', 'my-vllm', '--json'], stores);
    assert.equal(removed.exitCode, 0);
    assert.equal(JSON.parse(removed.stdout).ok, true);
    assert.deepEqual(storedProviders(stores), {});

    const missing = runProviderCli(['remove', '--name', 'my-vllm', '--json'], stores);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /my-vllm/);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('provider CLI: an unknown flag is refused before anything is written', () => {
  const stores = tmpStores();
  try {
    const result = runProviderCli([...ADD_ARGS, '--secret', 'x'], stores);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--secret/);
    assert.equal(fs.existsSync(stores.connectionsPath), false);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});
