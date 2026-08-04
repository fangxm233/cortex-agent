// input:  temporary models.json and gateway.yaml fixtures
// output: custom PI provider validation, storage, and orchestration contracts
// pos:    Regression tests for user-defined PI provider management
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { parse as yamlParse } from 'yaml';

import {
  GATEWAY_PLACEHOLDER_KEY,
  customProviderBaseUrl,
  gatewayAuthStyle,
  gatewayEndpoint,
  validateCustomProvider,
} from '../../src/domain/pi-providers/custom-provider-model.js';
import {
  readCustomProviderEntries,
  removeModelsJsonProvider,
  upsertModelsJsonProvider,
} from '../../src/domain/pi-providers/models-json-store.js';
import {
  readGatewayRoute,
  removeGatewayRoute,
  upsertGatewayRoute,
} from '../../src/domain/pi-providers/gateway-route-store.js';
import {
  listCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
  type CustomProviderStores,
} from '../../src/domain/pi-providers/custom-provider-service.js';

function tmpStores(): CustomProviderStores & { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-custom-provider-'));
  return {
    dir,
    modelsPath: path.join(dir, 'pi', 'models.json'),
    gatewayPath: path.join(dir, 'aistatus', 'gateway.yaml'),
    gatewayUrl: 'http://127.0.0.1:9880',
  };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readYaml(file: string): any {
  return yamlParse(fs.readFileSync(file, 'utf8'));
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

test('validateCustomProvider: rejects a name already used by a built-in provider', () => {
  const issues = validateCustomProvider({ ...VALID, name: 'anthropic' }, { reservedNames: ['anthropic', 'deepseek'] });
  assert.deepEqual(issues, ['name-reserved']);
  assert.deepEqual(validateCustomProvider(VALID, { reservedNames: ['anthropic'] }), []);
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

test('gatewayAuthStyle: maps every supported PI api onto a gateway auth style', () => {
  assert.equal(gatewayAuthStyle('anthropic-messages'), 'anthropic');
  assert.equal(gatewayAuthStyle('openai-completions'), 'openai');
  assert.equal(gatewayAuthStyle('openai-responses'), 'openai');
  assert.equal(gatewayAuthStyle('google-generative-ai'), 'google');
});

test('customProviderBaseUrl: points PI at the gateway mode route, not the upstream', () => {
  const anthropic = customProviderBaseUrl('http://127.0.0.1:9880', 'my-vllm', 'anthropic-messages');
  assert.equal(anthropic, 'http://127.0.0.1:9880/m/my-vllm/anthropic');
  assert.equal(
    customProviderBaseUrl('http://127.0.0.1:9880/', 'my-vllm', 'anthropic-messages'),
    'http://127.0.0.1:9880/m/my-vllm/anthropic',
  );
  assert.equal(
    customProviderBaseUrl('http://127.0.0.1:9880', 'my-proxy', 'openai-completions'),
    'http://127.0.0.1:9880/m/my-proxy/my-proxy',
  );
});

test('gatewayEndpoint: anthropic-protocol providers share the endpoint the Claude backend calls', () => {
  assert.equal(gatewayEndpoint('anthropic-messages', 'my-vllm'), 'anthropic');
  assert.equal(gatewayEndpoint('openai-completions', 'my-proxy'), 'my-proxy');
  assert.equal(gatewayEndpoint('google-generative-ai', 'my-gemini'), 'my-gemini');
});

// ─── models.json store ───────────────────────────────────────────

test('upsertModelsJsonProvider: creates the file with the provider entry', () => {
  const { dir, modelsPath } = tmpStores();
  try {
    upsertModelsJsonProvider(modelsPath, 'my-vllm', {
      baseUrl: 'http://127.0.0.1:9880/m/my-vllm/my-vllm',
      api: 'anthropic-messages',
      apiKey: GATEWAY_PLACEHOLDER_KEY,
      models: [{ id: 'Model-27B' }],
    });
    const data = readJson(modelsPath);
    assert.equal(data.providers['my-vllm'].api, 'anthropic-messages');
    assert.equal(data.providers['my-vllm'].baseUrl, 'http://127.0.0.1:9880/m/my-vllm/my-vllm');
    assert.deepEqual(data.providers['my-vllm'].models, [{ id: 'Model-27B' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertModelsJsonProvider: preserves other providers and unknown top-level keys', () => {
  const { dir, modelsPath } = tmpStores();
  try {
    fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: {
        anthropic: { baseUrl: 'http://127.0.0.1:9880/anthropic' },
        'hand-written': { baseUrl: 'http://box:1234', api: 'openai-completions', models: [{ id: 'x' }] },
      },
      somethingElse: { keep: true },
    }, null, 2));
    upsertModelsJsonProvider(modelsPath, 'my-vllm', { baseUrl: 'u', api: 'anthropic-messages', models: [{ id: 'm' }] });
    const data = readJson(modelsPath);
    assert.deepEqual(Object.keys(data.providers).sort(), ['anthropic', 'hand-written', 'my-vllm']);
    assert.equal(data.providers.anthropic.baseUrl, 'http://127.0.0.1:9880/anthropic');
    assert.deepEqual(data.somethingElse, { keep: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertModelsJsonProvider: replaces an existing entry instead of merging stale fields', () => {
  const { dir, modelsPath } = tmpStores();
  try {
    upsertModelsJsonProvider(modelsPath, 'my-vllm', {
      baseUrl: 'a', api: 'anthropic-messages', models: [{ id: 'old' }], headers: { 'x-old': '1' },
    });
    upsertModelsJsonProvider(modelsPath, 'my-vllm', { baseUrl: 'b', api: 'openai-completions', models: [{ id: 'new' }] });
    const entry = readJson(modelsPath).providers['my-vllm'];
    assert.equal(entry.api, 'openai-completions');
    assert.deepEqual(entry.models, [{ id: 'new' }]);
    assert.equal(entry.headers, undefined, 'stale headers do not survive a replace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertModelsJsonProvider: backs up an existing file before replacing it', () => {
  const { dir, modelsPath } = tmpStores();
  try {
    upsertModelsJsonProvider(modelsPath, 'first', { baseUrl: 'a', api: 'anthropic-messages', models: [{ id: 'm' }] });
    upsertModelsJsonProvider(modelsPath, 'second', { baseUrl: 'b', api: 'anthropic-messages', models: [{ id: 'm' }] });
    const backup = readJson(`${modelsPath}.bak`);
    assert.deepEqual(Object.keys(backup.providers), ['first']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeModelsJsonProvider: drops only the target and reports whether it existed', () => {
  const { dir, modelsPath } = tmpStores();
  try {
    upsertModelsJsonProvider(modelsPath, 'keep', { baseUrl: 'a', api: 'anthropic-messages', models: [{ id: 'm' }] });
    upsertModelsJsonProvider(modelsPath, 'drop', { baseUrl: 'b', api: 'anthropic-messages', models: [{ id: 'm' }] });
    assert.equal(removeModelsJsonProvider(modelsPath, 'drop'), true);
    assert.deepEqual(Object.keys(readJson(modelsPath).providers), ['keep']);
    assert.equal(removeModelsJsonProvider(modelsPath, 'absent'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readCustomProviderEntries: returns definitions only, never bare baseUrl overrides', () => {
  const { dir, modelsPath } = tmpStores();
  try {
    fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: {
        anthropic: { baseUrl: 'http://127.0.0.1:9880/anthropic' },
        deepseek: { baseUrl: 'http://127.0.0.1:9880/deepseek', compat: { supportsDeveloperRole: false } },
        'my-vllm': { baseUrl: 'http://box', api: 'anthropic-messages', models: [{ id: 'Model-27B' }] },
      },
    }));
    const entries = readCustomProviderEntries(modelsPath);
    assert.deepEqual(Object.keys(entries), ['my-vllm']);
    assert.equal(entries['my-vllm'].api, 'anthropic-messages');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readCustomProviderEntries: returns an empty map when the file is missing or unparsable', () => {
  const { dir, modelsPath } = tmpStores();
  try {
    assert.deepEqual(readCustomProviderEntries(modelsPath), {});
    fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
    fs.writeFileSync(modelsPath, '{ not json');
    assert.deepEqual(readCustomProviderEntries(modelsPath), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── gateway route store ─────────────────────────────────────────

test('upsertGatewayRoute: creates the route and the top-level fields on a fresh file', () => {
  const { dir, gatewayPath } = tmpStores();
  try {
    upsertGatewayRoute(gatewayPath, {
      endpoint: 'my-vllm',
      mode: 'my-vllm',
      base_url: 'http://127.0.0.1:8100',
      auth_style: 'anthropic',
      keys: ['secret-upstream-key'],
      passthrough: false,
    });
    const doc = readYaml(gatewayPath);
    assert.equal(doc.port, 9880);
    assert.equal(doc['my-vllm']['my-vllm'].base_url, 'http://127.0.0.1:8100');
    assert.equal(doc['my-vllm']['my-vllm'].auth_style, 'anthropic');
    assert.deepEqual(doc['my-vllm']['my-vllm'].keys, ['secret-upstream-key']);
    assert.equal(doc['my-vllm']['my-vllm'].passthrough, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertGatewayRoute: preserves unrelated routes, their keys, and the active mode', () => {
  const { dir, gatewayPath } = tmpStores();
  try {
    fs.mkdirSync(path.dirname(gatewayPath), { recursive: true });
    fs.writeFileSync(gatewayPath, [
      'port: 9880',
      'mode: plan',
      'status_check: true',
      'anthropic:',
      '  plan:',
      '    base_url: https://api.anthropic.com',
      '    auth_style: bearer',
      '  api:',
      '    base_url: https://relay.example.com',
      '    auth_style: anthropic',
      '    keys:',
      '      - hand-written-key',
      '',
    ].join('\n'));
    upsertGatewayRoute(gatewayPath, {
      endpoint: 'my-vllm', mode: 'my-vllm', base_url: 'http://127.0.0.1:8100',
      auth_style: 'anthropic', keys: [], passthrough: true,
    });
    const doc = readYaml(gatewayPath);
    assert.equal(doc.mode, 'plan', 'active billing mode is not hijacked');
    assert.equal(doc.anthropic.plan.base_url, 'https://api.anthropic.com');
    assert.deepEqual(doc.anthropic.api.keys, ['hand-written-key']);
    assert.equal(doc['my-vllm']['my-vllm'].base_url, 'http://127.0.0.1:8100');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertGatewayRoute: updates an existing route in place (what add-only merge cannot do)', () => {
  const { dir, gatewayPath } = tmpStores();
  try {
    upsertGatewayRoute(gatewayPath, {
      endpoint: 'my-vllm', mode: 'my-vllm', base_url: 'http://old:8100',
      auth_style: 'anthropic', keys: ['old-key'], passthrough: false,
    });
    upsertGatewayRoute(gatewayPath, {
      endpoint: 'my-vllm', mode: 'my-vllm', base_url: 'http://new:8100',
      auth_style: 'openai', keys: ['new-key'], passthrough: false,
    });
    const route = readYaml(gatewayPath)['my-vllm']['my-vllm'];
    assert.equal(route.base_url, 'http://new:8100');
    assert.equal(route.auth_style, 'openai');
    assert.deepEqual(route.keys, ['new-key']);
    assert.ok(fs.existsSync(`${gatewayPath}.bak`), 'the previous config is backed up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readGatewayRoute: returns the stored route or null when absent', () => {
  const { dir, gatewayPath } = tmpStores();
  try {
    assert.equal(readGatewayRoute(gatewayPath, 'my-vllm', 'my-vllm'), null);
    upsertGatewayRoute(gatewayPath, {
      endpoint: 'my-vllm', mode: 'my-vllm', base_url: 'http://box:8100',
      auth_style: 'anthropic', keys: ['k'], passthrough: false,
    });
    assert.equal(readGatewayRoute(gatewayPath, 'my-vllm', 'my-vllm')?.base_url, 'http://box:8100');
    assert.equal(readGatewayRoute(gatewayPath, 'other', 'other'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeGatewayRoute: drops the route and its emptied endpoint section only', () => {
  const { dir, gatewayPath } = tmpStores();
  try {
    upsertGatewayRoute(gatewayPath, {
      endpoint: 'keep', mode: 'keep', base_url: 'http://a', auth_style: 'openai', keys: [], passthrough: true,
    });
    upsertGatewayRoute(gatewayPath, {
      endpoint: 'drop', mode: 'drop', base_url: 'http://b', auth_style: 'openai', keys: [], passthrough: true,
    });
    assert.equal(removeGatewayRoute(gatewayPath, 'drop', 'drop'), true);
    const doc = readYaml(gatewayPath);
    assert.equal(doc.drop, undefined);
    assert.ok(doc.keep.keep);
    assert.equal(removeGatewayRoute(gatewayPath, 'absent', 'absent'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── service orchestration ───────────────────────────────────────

test('upsertCustomProvider: writes the PI catalog entry and the gateway route together', () => {
  const stores = tmpStores();
  try {
    const result = upsertCustomProvider(stores, VALID);
    assert.equal(result.ok, true);

    const entry = readJson(stores.modelsPath).providers['my-vllm'];
    assert.equal(entry.baseUrl, 'http://127.0.0.1:9880/m/my-vllm/anthropic');
    assert.equal(entry.api, 'anthropic-messages');
    assert.equal(entry.apiKey, GATEWAY_PLACEHOLDER_KEY);
    assert.deepEqual(entry.models, [{ id: 'Model-27B' }]);

    const route = readYaml(stores.gatewayPath).anthropic['my-vllm'];
    assert.equal(route.base_url, 'http://127.0.0.1:8100');
    assert.deepEqual(route.keys, ['secret-upstream-key']);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('upsertCustomProvider: keeps the upstream secret out of the PI catalog', () => {
  const stores = tmpStores();
  try {
    upsertCustomProvider(stores, VALID);
    const raw = fs.readFileSync(stores.modelsPath, 'utf8');
    assert.ok(!raw.includes('secret-upstream-key'), 'the upstream key never lands in models.json');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('upsertCustomProvider: routes an openai-family provider with the matching auth style', () => {
  const stores = tmpStores();
  try {
    upsertCustomProvider(stores, { ...VALID, name: 'my-proxy', api: 'openai-completions' });
    const route = readYaml(stores.gatewayPath)['my-proxy']['my-proxy'];
    assert.equal(route.auth_style, 'openai');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('upsertCustomProvider: an omitted apiKey on edit keeps the stored key', () => {
  const stores = tmpStores();
  try {
    upsertCustomProvider(stores, VALID);
    const result = upsertCustomProvider(stores, {
      name: 'my-vllm', api: 'anthropic-messages', upstreamUrl: 'http://127.0.0.1:8200',
      models: [{ id: 'Model-27B' }],
    });
    assert.equal(result.ok, true);
    const route = readYaml(stores.gatewayPath).anthropic['my-vllm'];
    assert.equal(route.base_url, 'http://127.0.0.1:8200');
    assert.deepEqual(route.keys, ['secret-upstream-key'], 'the key survives an edit that omits it');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('upsertCustomProvider: an empty apiKey clears the stored key and opens passthrough', () => {
  const stores = tmpStores();
  try {
    upsertCustomProvider(stores, VALID);
    upsertCustomProvider(stores, { ...VALID, apiKey: '' });
    const route = readYaml(stores.gatewayPath).anthropic['my-vllm'];
    assert.equal(route.keys, undefined);
    assert.equal(route.passthrough, true);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('upsertCustomProvider: a rejected definition writes nothing at all', () => {
  const stores = tmpStores();
  try {
    const result = upsertCustomProvider(stores, { ...VALID, name: 'bad name' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok === false ? result.errors : [], ['name-charset']);
    assert.equal(fs.existsSync(stores.modelsPath), false);
    assert.equal(fs.existsSync(stores.gatewayPath), false);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('upsertCustomProvider: a failed catalog write rolls the gateway route back', () => {
  const stores = tmpStores();
  try {
    // A directory where the catalog file should be makes the models.json write fail.
    fs.mkdirSync(stores.modelsPath, { recursive: true });
    const result = upsertCustomProvider(stores, VALID);
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok === false ? result.errors : [], ['write-failed']);
    assert.equal(readGatewayRoute(stores.gatewayPath, 'anthropic', 'my-vllm'), null);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('upsertCustomProvider: notifies the caller so provider discovery can refresh', () => {
  const stores = tmpStores();
  let changed = 0;
  try {
    upsertCustomProvider({ ...stores, onChanged: () => { changed += 1; } }, VALID);
    assert.equal(changed, 1);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('listCustomProviders: merges the catalog entry with its gateway route without leaking the key', () => {
  const stores = tmpStores();
  try {
    upsertCustomProvider(stores, VALID);
    upsertCustomProvider(stores, { ...VALID, name: 'keyless', apiKey: '' });
    const listed = listCustomProviders(stores);
    assert.deepEqual(listed.map((p) => p.name).sort(), ['keyless', 'my-vllm']);
    const vllm = listed.find((p) => p.name === 'my-vllm')!;
    assert.equal(vllm.api, 'anthropic-messages');
    assert.equal(vllm.upstreamUrl, 'http://127.0.0.1:8100');
    assert.equal(vllm.hasApiKey, true);
    assert.deepEqual(vllm.models, [{ id: 'Model-27B' }]);
    assert.equal((vllm as unknown as Record<string, unknown>).apiKey, undefined, 'the raw key is never returned');
    assert.equal(listed.find((p) => p.name === 'keyless')!.hasApiKey, false);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('listCustomProviders: reports a definition whose gateway route went missing', () => {
  const stores = tmpStores();
  try {
    upsertCustomProvider(stores, VALID);
    removeGatewayRoute(stores.gatewayPath, 'anthropic', 'my-vllm');
    const [provider] = listCustomProviders(stores);
    assert.equal(provider.routed, false, 'a definition without a gateway route is surfaced, not hidden');
    assert.equal(provider.upstreamUrl, null);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('removeCustomProvider: clears both files and reports an unknown name', () => {
  const stores = tmpStores();
  let changed = 0;
  try {
    upsertCustomProvider(stores, VALID);
    upsertCustomProvider(stores, { ...VALID, name: 'other' });
    const result = removeCustomProvider({ ...stores, onChanged: () => { changed += 1; } }, 'my-vllm');
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(readJson(stores.modelsPath).providers), ['other']);
    assert.equal(readGatewayRoute(stores.gatewayPath, 'anthropic', 'my-vllm'), null);
    assert.equal(changed, 1);

    const missing = removeCustomProvider(stores, 'never-existed');
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.ok === false ? missing.errors : [], ['not-found']);
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});

test('removeCustomProvider: refuses to touch a built-in baseUrl override', () => {
  const stores = tmpStores();
  try {
    fs.mkdirSync(path.dirname(stores.modelsPath), { recursive: true });
    fs.writeFileSync(stores.modelsPath, JSON.stringify({
      providers: { anthropic: { baseUrl: 'http://127.0.0.1:9880/anthropic' } },
    }));
    const result = removeCustomProvider(stores, 'anthropic');
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok === false ? result.errors : [], ['not-found']);
    assert.ok(readJson(stores.modelsPath).providers.anthropic, 'the override survives');
  } finally {
    fs.rmSync(stores.dir, { recursive: true, force: true });
  }
});
