// input:  temporary catalog/gateway stores and the UI-service registry
// output: custom provider list, upsert, remove, redaction and router tests
// pos:    Regression coverage for the Web custom PI provider surface
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { parse as yamlParse } from 'yaml';

import { handleCustomProvidersList } from '../../../src/domain/ui-service/query/custom-providers.js';
import {
  handleCustomProviderRemove,
  handleCustomProviderUpsert,
} from '../../../src/domain/ui-service/mutate/custom-providers.js';
import { createUiService, redactMutationAuditArgs } from '../../../src/domain/ui-service/ui-service.js';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import {
  authCustomProvidersInput,
  authRemoveCustomProviderInput,
  authUpsertCustomProviderInput,
} from '../../../src/domain/ui-service/input-schemas.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { CustomProviderStores } from '../../../src/domain/pi-providers/index.js';

const UPSTREAM_KEY = 'sentinel-upstream-key';

const DEFINITION = {
  name: 'my-vllm',
  api: 'anthropic-messages' as const,
  upstreamUrl: 'http://127.0.0.1:8100',
  apiKey: UPSTREAM_KEY,
  models: [{ id: 'Model-27B' }],
};

function tmpStores(): CustomProviderStores {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ui-provider-'));
  return {
    modelsPath: path.join(dir, 'pi', 'models.json'),
    gatewayPath: path.join(dir, 'aistatus', 'gateway.yaml'),
    gatewayUrl: 'http://127.0.0.1:9880',
  };
}

function depsWith(stores: CustomProviderStores, events: unknown[] = []): UiServiceDeps {
  return {
    customProviderStores: stores,
    bus: { publish: (event: unknown) => events.push(event) },
  } as unknown as UiServiceDeps;
}

test('auth.customProviders lists stored definitions without the upstream key', async () => {
  const stores = tmpStores();
  const deps = depsWith(stores);

  assert.deepEqual(await handleCustomProvidersList(deps, {}), []);
  const saved = await handleCustomProviderUpsert(deps, DEFINITION);
  assert.equal(saved.ok, true);

  const listed = await handleCustomProvidersList(deps, {});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'my-vllm');
  assert.equal(listed[0].api, 'anthropic-messages');
  assert.equal(listed[0].upstreamUrl, 'http://127.0.0.1:8100');
  assert.equal(listed[0].hasApiKey, true);
  assert.equal(listed[0].routed, true);
  assert.deepEqual(listed[0].models, [{ id: 'Model-27B' }]);
  assert.ok(!JSON.stringify(listed).includes(UPSTREAM_KEY));
});

test('auth.upsertCustomProvider writes the catalog entry and the gateway route', async () => {
  const stores = tmpStores();
  const result = await handleCustomProviderUpsert(depsWith(stores), DEFINITION);

  assert.equal(result.ok, true);
  const catalog = JSON.parse(fs.readFileSync(stores.modelsPath, 'utf8'));
  assert.equal(catalog.providers['my-vllm'].baseUrl, 'http://127.0.0.1:9880/m/my-vllm/anthropic');
  assert.equal(catalog.providers['my-vllm'].api, 'anthropic-messages');
  assert.ok(!fs.readFileSync(stores.modelsPath, 'utf8').includes(UPSTREAM_KEY));

  const gateway = yamlParse(fs.readFileSync(stores.gatewayPath, 'utf8'));
  assert.equal(gateway.anthropic['my-vllm'].base_url, 'http://127.0.0.1:8100');
  assert.deepEqual(gateway.anthropic['my-vllm'].keys, [UPSTREAM_KEY]);
});

test('auth.upsertCustomProvider reports a rejected definition as invalid-args', async () => {
  const stores = tmpStores();
  const result = await handleCustomProviderUpsert(depsWith(stores), {
    ...DEFINITION,
    upstreamUrl: 'ftp://box/api',
  });

  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, 'invalid-args');
  assert.match((result as { message: string }).message, /http/i);
  assert.equal(fs.existsSync(stores.modelsPath), false);
});

test('auth.removeCustomProvider deletes both files and reports a missing name', async () => {
  const stores = tmpStores();
  const deps = depsWith(stores);
  await handleCustomProviderUpsert(deps, DEFINITION);

  const removed = await handleCustomProviderRemove(deps, { name: 'my-vllm' });
  assert.deepEqual(removed, { ok: true, data: { removed: true } });
  assert.deepEqual(await handleCustomProvidersList(deps, {}), []);
  const gateway = yamlParse(fs.readFileSync(stores.gatewayPath, 'utf8'));
  assert.equal(gateway.anthropic?.['my-vllm'], undefined);

  const missing = await handleCustomProviderRemove(deps, { name: 'my-vllm' });
  assert.equal(missing.ok, false);
  assert.equal((missing as { code: string }).code, 'not-found');
});

test('an edit that omits the key keeps the stored upstream secret', async () => {
  const stores = tmpStores();
  const deps = depsWith(stores);
  await handleCustomProviderUpsert(deps, DEFINITION);

  const edited = await handleCustomProviderUpsert(deps, {
    name: 'my-vllm',
    api: 'anthropic-messages',
    upstreamUrl: 'http://127.0.0.1:8200',
    models: [{ id: 'Model-27B' }],
  });

  assert.equal(edited.ok, true);
  const gateway = yamlParse(fs.readFileSync(stores.gatewayPath, 'utf8'));
  assert.equal(gateway.anthropic['my-vllm'].base_url, 'http://127.0.0.1:8200');
  assert.deepEqual(gateway.anthropic['my-vllm'].keys, [UPSTREAM_KEY]);
  assert.equal((await handleCustomProvidersList(deps, {}))[0].hasApiKey, true);
});

test('the upsert audit event carries no upstream key', async () => {
  const events: any[] = [];
  const service = createUiService(depsWith(tmpStores(), events));

  const result = await service.mutate('auth.upsertCustomProvider', DEFINITION);

  assert.equal(result.ok, true);
  const audit = events.find((event) => event.type === 'ui.mutate-invoked');
  assert.equal(audit.args.name, 'my-vllm');
  assert.equal(audit.args.apiKey, undefined);
  assert.ok(!JSON.stringify(events).includes(UPSTREAM_KEY));
  assert.deepEqual(
    redactMutationAuditArgs('auth.upsertCustomProvider', { name: 'x', apiKey: UPSTREAM_KEY }),
    { name: 'x' },
  );
});

test('typed custom provider ops round-trip through the tRPC router', async () => {
  const stores = tmpStores();
  const caller = createAppRouter(createUiService(depsWith(stores))).createCaller({});

  const saved = await caller.auth.upsertCustomProvider(DEFINITION);
  assert.equal(saved.name, 'my-vllm');
  assert.equal((await caller.auth.customProviders({})).length, 1);
  assert.deepEqual(await caller.auth.removeCustomProvider({ name: 'my-vllm' }), { removed: true });
  assert.deepEqual(await caller.auth.customProviders({}), []);
});

test('custom provider input schemas gate the shape before the handler runs', () => {
  assert.equal(authCustomProvidersInput.safeParse({}).success, true);
  assert.equal(authRemoveCustomProviderInput.safeParse({ name: 'my vllm' }).success, false);
  assert.equal(authUpsertCustomProviderInput.safeParse(DEFINITION).success, true);
  assert.equal(
    authUpsertCustomProviderInput.safeParse({ ...DEFINITION, api: 'ollama-native' }).success,
    false,
  );
  assert.equal(authUpsertCustomProviderInput.safeParse({ ...DEFINITION, models: [] }).success, false);
});
