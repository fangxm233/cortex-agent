// input:  injected PI scan results, custom providers and gateway mode maps
// output: models.catalog union, mode fallbacks and piPending assertions
// pos:    Regression coverage for the profile editor's engine catalog
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { handleModelsCatalog, type ModelsCatalogReaders } from '../../../src/domain/ui-service/query/models.js';
import { ANTHROPIC_MODELS } from '../../../src/core/anthropic-models.js';
import type { ModelCatalogRoute, UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const DEPS = {} as UiServiceDeps;

function readers(overrides: Partial<ModelsCatalogReaders> = {}): ModelsCatalogReaders {
  return {
    piModels: () => [],
    piPeek: () => [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
    customProviders: () => [],
    gatewayModes: () => ({}),
    ...overrides,
  };
}

function routeOf(routes: ModelCatalogRoute[], endpoint: string): ModelCatalogRoute {
  const route = routes.find((candidate) => candidate.endpoint === endpoint);
  assert.ok(route, `expected a route for ${endpoint}`);
  return route;
}

test('anthropic is always present with the built-in model table', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers());
  const anthropic = routeOf(snapshot.routes, 'anthropic');
  assert.equal(anthropic.backend, 'claude');
  assert.equal(anthropic.provider, null);
  assert.equal(anthropic.source, 'builtin');
  assert.deepEqual(anthropic.models, [...ANTHROPIC_MODELS]);
  // No gateway section read ⇒ the claude endpoint still offers its conventional route.
  assert.deepEqual(anthropic.modes, ['plan']);
});

test('gateway.yaml owns the mode list of an endpoint it declares', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    gatewayModes: () => ({ anthropic: ['plan', 'api'], deepseek: ['deepseek'] }),
  }));
  assert.deepEqual(routeOf(snapshot.routes, 'anthropic').modes, ['plan', 'api']);
  const deepseek = routeOf(snapshot.routes, 'deepseek');
  assert.equal(deepseek.backend, 'pi');
  assert.equal(deepseek.provider, 'deepseek');
  assert.equal(deepseek.source, 'gateway');
  // Known route, unknown models: the editor falls back to free text rather than blocking the field.
  assert.deepEqual(deepseek.models, []);
});

test('PI pairs group into one route per provider and dedupe', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    piModels: () => [
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'deepseek', model: 'deepseek-v4' },
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'openai-codex', model: 'gpt-6-astra' },
    ],
  }));
  const deepseek = routeOf(snapshot.routes, 'deepseek');
  assert.equal(deepseek.source, 'pi');
  assert.deepEqual(deepseek.models, ['deepseek-v4-flash', 'deepseek-v4']);
  // No gateway section for this provider ⇒ mode falls back to the provider name, the same rule
  // discoverEndpoints applies when it generates the route.
  assert.deepEqual(deepseek.modes, ['deepseek']);
  assert.deepEqual(routeOf(snapshot.routes, 'openai-codex').models, ['gpt-6-astra']);
});

test('a custom provider contributes its declared models without any PI scan', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    customProviders: () => ([{
      name: 'my-vllm',
      api: 'anthropic-messages',
      models: [{ id: 'Model-27B' }, { id: 'Model-9B' }],
      upstreamUrl: 'http://127.0.0.1:8100',
      hasApiKey: true,
      routed: true,
    }]),
  }));
  const custom = routeOf(snapshot.routes, 'my-vllm');
  assert.equal(custom.source, 'custom');
  assert.equal(custom.provider, 'my-vllm');
  assert.deepEqual(custom.models, ['Model-27B', 'Model-9B']);
});

test('sources union rather than override: a later source only adds models', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    piModels: () => [{ provider: 'my-vllm', model: 'Model-27B' }],
    customProviders: () => ([{
      name: 'my-vllm',
      api: 'anthropic-messages',
      models: [{ id: 'Model-27B' }, { id: 'Model-9B' }],
      upstreamUrl: null,
      hasApiKey: false,
      routed: false,
    }]),
    gatewayModes: () => ({ 'my-vllm': ['my-vllm'] }),
  }));
  assert.equal(snapshot.routes.filter((route) => route.endpoint === 'my-vllm').length, 1);
  const route = routeOf(snapshot.routes, 'my-vllm');
  assert.equal(route.source, 'pi');
  assert.deepEqual(route.models, ['Model-27B', 'Model-9B']);
});

test('piPending reports an unwarmed PI cache, independent of what the scan returned', async () => {
  const pending = await handleModelsCatalog(DEPS, {}, readers({ piPeek: () => [] }));
  assert.equal(pending.piPending, true);
  const warm = await handleModelsCatalog(DEPS, {}, readers());
  assert.equal(warm.piPending, false);
});
