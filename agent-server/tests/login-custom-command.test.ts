import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';

import {
  handleCustomProviderCommand,
  parseCustomProviderRequest,
} from '../src/orchestration/routing/commands/login-custom.js';
import { upsertCustomProvider } from '../src/domain/pi-providers/index.js';
import type { CustomProviderStores } from '../src/domain/pi-providers/index.js';

function tmpStores(): CustomProviderStores {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-login-custom-'));
  return { connectionsPath: path.join(dir, 'config', 'connections.json') };
}

/** The PI connection stored for `name`, if any. */
function storedProvider(stores: CustomProviderStores, name: string): any {
  const { connections } = JSON.parse(fs.readFileSync(stores.connectionsPath, 'utf8'));
  return connections.find((entry: any) => entry.backend === 'pi' && entry.id === name);
}

function seed(stores: CustomProviderStores): void {
  const result = upsertCustomProvider(stores, {
    name: 'my-vllm',
    api: 'anthropic-messages',
    upstreamUrl: 'http://127.0.0.1:8100',
    apiKey: 'sentinel-upstream-key',
    models: [{ id: 'Model-27B' }],
  });
  assert.equal(result.ok, true);
}

test('parses the list, add and remove forms and rejects the rest', () => {
  assert.deepEqual(parseCustomProviderRequest([]), { kind: 'list' });
  assert.deepEqual(parseCustomProviderRequest(['list']), { kind: 'list' });
  assert.deepEqual(parseCustomProviderRequest(['remove', 'my-vllm']), { kind: 'remove', name: 'my-vllm' });
  assert.deepEqual(
    parseCustomProviderRequest(['add', 'my-vllm', 'anthropic-messages', 'http://127.0.0.1:8100', 'A', 'B']),
    {
      kind: 'add',
      name: 'my-vllm',
      api: 'anthropic-messages',
      upstreamUrl: 'http://127.0.0.1:8100',
      models: ['A', 'B'],
    },
  );
  assert.deepEqual(parseCustomProviderRequest(['remove']), { kind: 'usage' });
  assert.deepEqual(parseCustomProviderRequest(['add', 'only-a-name']), { kind: 'usage' });
  assert.deepEqual(parseCustomProviderRequest(['whatever']), { kind: 'usage' });
});

test('lists stored providers without their upstream key', async () => {
  const stores = tmpStores();
  seed(stores);

  const result = await handleCustomProviderCommand([], stores);

  assert.match(result.text, /my-vllm/);
  assert.match(result.text, /anthropic-messages/);
  assert.match(result.text, /127\.0\.0\.1:8100/);
  assert.ok(!result.text.includes('sentinel-upstream-key'));
});

test('adds a keyless provider and points elsewhere for the upstream key', async () => {
  const stores = tmpStores();

  const result = await handleCustomProviderCommand(
    ['add', 'my-proxy', 'openai-completions', 'https://proxy.example.com/v1', 'small'],
    stores,
  );

  assert.match(result.text, /my-proxy/);
  assert.match(result.text, /cortex auth provider/);
  const stored = storedProvider(stores, 'my-proxy');
  assert.equal(stored.api, 'openai-completions');
  assert.deepEqual(stored.models, [{ id: 'small' }]);
  assert.equal(stored.key, undefined);
});

test('an add that the server refuses changes nothing and says why', async () => {
  const stores = tmpStores();

  const result = await handleCustomProviderCommand(
    ['add', 'my-proxy', 'ollama-native', 'https://proxy.example.com/v1', 'small'],
    stores,
  );

  assert.match(result.text, /protocol/i);
  assert.equal(fs.existsSync(stores.connectionsPath), false);
});

test('removes a stored provider and reports an unknown name', async () => {
  const stores = tmpStores();
  seed(stores);

  const removed = await handleCustomProviderCommand(['remove', 'my-vllm'], stores);
  assert.match(removed.text, /my-vllm/);
  assert.equal(storedProvider(stores, 'my-vllm'), undefined);

  const missing = await handleCustomProviderCommand(['remove', 'my-vllm'], stores);
  assert.match(missing.text, /my-vllm/);
});
