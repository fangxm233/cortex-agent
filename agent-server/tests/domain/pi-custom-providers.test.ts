import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';

import { validateCustomProvider } from '../../src/domain/pi-providers/custom-provider-model.js';
import { readCustomProviderEntries } from '../../src/agent-adapter/pi/custom-catalog.js';
import {
  listCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
  type CustomProviderStores,
} from '../../src/domain/pi-providers/custom-provider-service.js';

function tmpStores(): CustomProviderStores & { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-custom-provider-'));
  return { dir, connectionsPath: path.join(dir, 'config', 'connections.json') };
}

/** Run `body` over fresh stores in a temp dir, removed afterwards. */
function withStores(body: (stores: CustomProviderStores & { dir: string }) => void): () => void {
  return () => {
    const stores = tmpStores();
    try {
      body(stores);
    } finally {
      fs.rmSync(stores.dir, { recursive: true, force: true });
    }
  };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function storedConnections(stores: CustomProviderStores): any[] {
  return readJson(stores.connectionsPath).connections;
}

function storedProvider(stores: CustomProviderStores, name: string): any {
  return storedConnections(stores).find((entry) => entry.backend === 'pi' && entry.id === name);
}

function seedConnections(stores: CustomProviderStores, connections: unknown[]): void {
  fs.mkdirSync(path.dirname(stores.connectionsPath), { recursive: true });
  fs.writeFileSync(stores.connectionsPath, JSON.stringify({ version: 1, connections }));
}

const VALID = {
  name: 'my-vllm',
  api: 'anthropic-messages' as const,
  upstreamUrl: 'http://127.0.0.1:8100',
  apiKey: 'secret-upstream-key',
  models: [{ id: 'Model-27B' }],
};

// ─── validation ──────────────────────────────────────────────────

test('validateCustomProvider: accepts a minimal well-formed definition', () => {
  assert.deepEqual(validateCustomProvider(VALID), []);
});

test('validateCustomProvider: rejects an empty or non-conforming name', () => {
  assert.deepEqual(validateCustomProvider({ ...VALID, name: '' }), ['name-required']);
  assert.deepEqual(validateCustomProvider({ ...VALID, name: 'my vllm' }), ['name-charset']);
  assert.deepEqual(validateCustomProvider({ ...VALID, name: 'my/vllm' }), ['name-charset']);
});

test('validateCustomProvider: rejects an unknown api and a non-http upstream', () => {
  assert.deepEqual(validateCustomProvider({ ...VALID, api: 'ollama-native' as never }), ['api-invalid']);
  assert.deepEqual(validateCustomProvider({ ...VALID, upstreamUrl: 'ftp://box/api' }), ['upstream-scheme']);
  assert.deepEqual(validateCustomProvider({ ...VALID, upstreamUrl: '' }), ['upstream-required']);
});

test('validateCustomProvider: requires at least one model with a usable id', () => {
  assert.deepEqual(validateCustomProvider({ ...VALID, models: [] }), ['models-required']);
  assert.deepEqual(validateCustomProvider({ ...VALID, models: [{ id: '  ' }] }), ['model-id-required']);
  assert.deepEqual(
    validateCustomProvider({ ...VALID, models: [{ id: 'a' }, { id: 'a' }] }),
    ['model-id-duplicate'],
  );
});

// ─── PI catalog reader ───────────────────────────────────────────

test('readCustomProviderEntries: returns definitions only, never bare baseUrl overrides', withStores(({ dir }) => {
  const modelsPath = path.join(dir, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({
    providers: {
      anthropic: { baseUrl: 'https://relay.example.invalid/anthropic' },
      deepseek: { baseUrl: 'https://relay.example.invalid/ds', compat: { supportsDeveloperRole: false } },
      'my-vllm': { baseUrl: 'http://box', api: 'anthropic-messages', models: [{ id: 'Model-27B' }] },
    },
  }));
  const entries = readCustomProviderEntries(modelsPath);
  assert.deepEqual(Object.keys(entries), ['my-vllm']);
  assert.equal(entries['my-vllm'].api, 'anthropic-messages');
}));

// ─── service over connections.json ───────────────────────────────

test('upsertCustomProvider: stores the complete definition, at its own URL, as a PI connection', withStores((stores) => {
  const result = upsertCustomProvider(stores, VALID);
  assert.equal(result.ok, true);
  assert.deepEqual(storedProvider(stores, 'my-vllm'), {
    id: 'my-vllm', backend: 'pi', provider: 'my-vllm', api: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:8100', key: 'secret-upstream-key', models: [{ id: 'Model-27B' }],
  });
}));

test('upsertCustomProvider: the connections file carrying the key is owner-only', { skip: process.platform === 'win32' }, withStores((stores) => {
  upsertCustomProvider(stores, VALID);
  assert.equal(fs.statSync(stores.connectionsPath).mode & 0o777, 0o600);
}));

test('upsertCustomProvider: keeps other connections, including a Claude one of the same name', withStores((stores) => {
  seedConnections(stores, [
    { id: 'my-vllm', backend: 'claude', label: 'Relay', authStyle: 'bearer', key: 'sk-fake-claude', billing: 'metered' },
    { id: 'deepseek', backend: 'pi', provider: 'deepseek', baseUrl: 'https://relay.example.invalid/ds' },
  ]);
  upsertCustomProvider(stores, VALID);
  const keys = storedConnections(stores).map((entry) => `${entry.backend}:${entry.id}`);
  assert.deepEqual(keys, ['claude:my-vllm', 'pi:deepseek', 'pi:my-vllm']);
}));

test('upsertCustomProvider: an omitted apiKey on edit keeps the stored key', withStores((stores) => {
  upsertCustomProvider(stores, VALID);
  const result = upsertCustomProvider(stores, {
    name: 'my-vllm', api: 'anthropic-messages', upstreamUrl: 'http://127.0.0.1:8200',
    models: [{ id: 'Model-27B' }],
  });
  assert.equal(result.ok, true);
  const stored = storedProvider(stores, 'my-vllm');
  assert.equal(stored.baseUrl, 'http://127.0.0.1:8200');
  assert.equal(stored.key, 'secret-upstream-key', 'the key survives an edit that omits it');
}));

test('upsertCustomProvider: an empty apiKey clears the stored key', withStores((stores) => {
  upsertCustomProvider(stores, VALID);
  const result = upsertCustomProvider(stores, { ...VALID, apiKey: '' });
  assert.equal(result.ok === true && result.provider.hasApiKey, false);
  assert.equal(storedProvider(stores, 'my-vllm').key, undefined);
}));

test('upsertCustomProvider: a rejected definition writes nothing at all', withStores((stores) => {
  const result = upsertCustomProvider(stores, { ...VALID, name: 'bad name' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false ? result.errors : [], ['name-charset']);
  assert.equal(fs.existsSync(stores.connectionsPath), false);
}));

test('upsertCustomProvider: a failed write is reported and does not signal a change', withStores((stores) => {
  // A directory where the connections file should be makes the write fail.
  fs.mkdirSync(stores.connectionsPath, { recursive: true });
  let changed = 0;
  const result = upsertCustomProvider({ ...stores, onChanged: () => { changed += 1; } }, VALID);
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false ? result.errors : [], ['write-failed']);
  assert.equal(changed, 0);
}));

test('listCustomProviders: lists custom definitions only, without leaking the key', withStores((stores) => {
  seedConnections(stores, [{ id: 'deepseek', backend: 'pi', provider: 'deepseek', baseUrl: 'https://relay.example.invalid/ds' }]);
  upsertCustomProvider(stores, VALID);
  upsertCustomProvider(stores, { ...VALID, name: 'keyless', apiKey: '' });
  const listed = listCustomProviders(stores);
  assert.deepEqual(listed.map((p) => p.name).sort(), ['keyless', 'my-vllm']);
  const vllm = listed.find((p) => p.name === 'my-vllm')!;
  assert.equal(vllm.api, 'anthropic-messages');
  assert.equal(vllm.upstreamUrl, 'http://127.0.0.1:8100');
  assert.equal(vllm.hasApiKey, true);
  assert.equal(vllm.routed, true);
  assert.deepEqual(vllm.models, [{ id: 'Model-27B' }]);
  assert.ok(!JSON.stringify(listed).includes('secret-upstream-key'), 'the raw key is never returned');
  assert.equal(listed.find((p) => p.name === 'keyless')!.hasApiKey, false);
}));

test('removeCustomProvider: removes only the target and reports an unknown name', withStores((stores) => {
  let changed = 0;
  upsertCustomProvider(stores, VALID);
  upsertCustomProvider(stores, { ...VALID, name: 'other' });
  const result = removeCustomProvider({ ...stores, onChanged: () => { changed += 1; } }, 'my-vllm');
  assert.equal(result.ok, true);
  assert.deepEqual(storedConnections(stores).map((entry) => entry.id), ['other']);
  assert.equal(changed, 1);

  const missing = removeCustomProvider(stores, 'never-existed');
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.ok === false ? missing.errors : [], ['not-found']);
}));

test('removeCustomProvider: refuses to touch a built-in baseUrl override', withStores((stores) => {
  seedConnections(stores, [{ id: 'anthropic', backend: 'pi', provider: 'anthropic', baseUrl: 'https://relay.example.invalid/anthropic' }]);
  const result = removeCustomProvider(stores, 'anthropic');
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false ? result.errors : [], ['not-found']);
  assert.ok(storedProvider(stores, 'anthropic'), 'the override survives');
}));

test('provider edits preserve advanced metadata only for retained models', withStores((stores) => {
  seedConnections(stores, [{
    id: VALID.name, backend: 'pi', provider: VALID.name, api: VALID.api, baseUrl: 'http://old',
    headers: { 'x-custom': 'yes' }, compat: { supportsStore: false },
    models: [
      { id: 'Model-27B', contextWindow: 100000, maxTokens: 4096, reasoning: true, custom: 1 },
      { id: 'removed', maxTokens: 2048 },
    ],
  }]);
  assert.equal(upsertCustomProvider(stores, VALID).ok, true);
  let entry = storedProvider(stores, VALID.name);
  assert.deepEqual(entry.headers, { 'x-custom': 'yes' });
  assert.deepEqual(entry.compat, { supportsStore: false });
  assert.deepEqual(entry.models, [
    { id: 'Model-27B', contextWindow: 100000, maxTokens: 4096, reasoning: true, custom: 1 },
  ]);
  // Empty maps clear what was stored; a model's own field is replaced by the edited value.
  upsertCustomProvider(stores, { ...VALID, headers: {}, compat: {}, models: [{ id: 'Model-27B', reasoning: false }] });
  entry = storedProvider(stores, VALID.name);
  assert.equal(entry.headers, undefined);
  assert.equal(entry.compat, undefined);
  assert.equal(entry.models[0].reasoning, false);
}));
