// input:  provider CLI arguments and temporary store paths
// output: custom provider CLI parsing, output shape and exit codes
// pos:    Unit tests for the cortex auth provider CLI
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { parse as yamlParse } from 'yaml';

import { runProviderCli } from '../../src/entry/provider-cli.js';
import type { CustomProviderStores } from '../../src/domain/pi-providers/index.js';

function tmpStores(): CustomProviderStores & { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-provider-cli-'));
  return {
    dir,
    modelsPath: path.join(dir, 'models.json'),
    gatewayPath: path.join(dir, 'gateway.yaml'),
    gatewayUrl: 'http://127.0.0.1:9880',
  };
}

const ADD_ARGS = [
  'add', '--name', 'my-vllm', '--api', 'anthropic-messages',
  '--url', 'http://127.0.0.1:8100', '--key', 'upstream-secret', '--model', 'Model-27B',
];

test('provider CLI: --help lists the subcommands and exits zero', () => {
  const stores = tmpStores();
  try {
    for (const args of [[], ['--help'], ['-h']]) {
      const result = runProviderCli(args, stores);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /cortex auth provider/);
      assert.match(result.stdout, /add/);
      assert.match(result.stdout, /remove/);
    }
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('provider CLI: an unknown subcommand names the valid ones and exits non-zero', () => {
  const stores = tmpStores();
  try {
    const result = runProviderCli(['ad'], stores);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ad/);
    assert.match(result.stderr, /list/);
    assert.match(result.stderr, /add/);
    assert.match(result.stderr, /remove/);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('provider CLI: add writes both files and reports the stored provider as JSON', () => {
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

    const catalog = JSON.parse(fs.readFileSync(stores.modelsPath, 'utf8'));
    assert.equal(catalog.providers['my-vllm'].baseUrl, 'http://127.0.0.1:9880/m/my-vllm/anthropic');
    const route = yamlParse(fs.readFileSync(stores.gatewayPath, 'utf8')).anthropic['my-vllm'];
    assert.deepEqual(route.keys, ['upstream-secret']);
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
    const route = yamlParse(fs.readFileSync(stores.gatewayPath, 'utf8'))['my-proxy']['my-proxy'];
    assert.deepEqual(route.keys, ['piped-secret'], 'the piped secret is trimmed');
    assert.equal(route.auth_style, 'openai');
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
    const catalog = JSON.parse(fs.readFileSync(stores.modelsPath, 'utf8'));
    assert.deepEqual(Object.keys(catalog.providers), ['my-vllm']);
    const route = yamlParse(fs.readFileSync(stores.gatewayPath, 'utf8')).anthropic['my-vllm'];
    assert.equal(route.base_url, 'http://127.0.0.1:8200');
    assert.deepEqual(route.keys, ['upstream-secret'], 'an omitted key keeps the stored one');
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
    assert.equal(fs.existsSync(stores.modelsPath), false, 'a rejected add writes nothing');
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
    const catalog = JSON.parse(fs.readFileSync(stores.modelsPath, 'utf8'));
    assert.ok(catalog.providers['my-vllm'], 'dry run leaves the provider in place');
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
    assert.deepEqual(JSON.parse(fs.readFileSync(stores.modelsPath, 'utf8')).providers, {});

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
    assert.equal(fs.existsSync(stores.modelsPath), false);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});
