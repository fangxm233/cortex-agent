import assert from 'node:assert/strict';
import { test } from 'vitest';

import { handleModelsCatalog, type ModelsCatalogReaders } from '../../../src/domain/ui-service/query/models.js';
import { ANTHROPIC_MODELS } from '../../../src/core/anthropic-models.js';
import type { ConnectionView } from '../../../src/domain/connections/inventory.js';
import type { ModelCatalogRoute, UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const DEPS = {} as UiServiceDeps;

function claudeView(id: string, overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id, backend: 'claude', provider: null, kind: 'key', label: id, baseUrl: null, billing: 'metered',
    authenticated: true, keyHint: 'sk-…fake', models: null, ...overrides,
  };
}

function piOverride(provider: string): ConnectionView {
  return {
    id: provider, backend: 'pi', provider, kind: 'override', label: provider,
    baseUrl: 'https://relay.example.test', billing: 'metered', authenticated: true, keyHint: null, models: null,
  };
}

const SUBSCRIPTION = claudeView('subscription', { kind: 'subscription', billing: 'subscription', keyHint: null });

function readers(overrides: Partial<ModelsCatalogReaders> = {}): ModelsCatalogReaders {
  return {
    // Always injected: the default reader would ask the live Models API with this host's own
    // credential, which a unit test must never depend on.
    connections: () => [SUBSCRIPTION],
    claudeModels: async () => [],
    piModels: async () => [],
    piPeek: () => [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
    customProviders: () => [],
    ...overrides,
  };
}

function routeOf(routes: ModelCatalogRoute[], endpoint: string): ModelCatalogRoute {
  const route = routes.find((candidate) => candidate.endpoint === endpoint);
  assert.ok(route, `expected a route for ${endpoint}`);
  return route;
}

test('anthropic falls back to the built-in model table when discovery answers nothing', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers());
  const anthropic = routeOf(snapshot.routes, 'anthropic');
  assert.equal(anthropic.backend, 'claude');
  assert.equal(anthropic.provider, null);
  assert.equal(anthropic.source, 'builtin');
  assert.deepEqual(anthropic.models, [...ANTHROPIC_MODELS]);
  assert.deepEqual(anthropic.connections, ['subscription']);
});

test('a host with no Claude connection offers no Claude models and skips discovery', async () => {
  let discovered = 0;
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    connections: () => [piOverride('deepseek')],
    claudeModels: async () => { discovered += 1; return []; },
  }));
  assert.equal(snapshot.routes.some((route) => route.backend === 'claude'), false);
  assert.equal(discovered, 0);
  assert.equal(routeOf(snapshot.routes, 'deepseek').backend, 'pi');
});

test('the Claude route lists the host\'s connections in order; a PI override alone declares its provider', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    piPeek: () => [],
    connections: () => [SUBSCRIPTION, claudeView('api'), claudeView('relay'), piOverride('deepseek')],
  }));
  assert.deepEqual(routeOf(snapshot.routes, 'anthropic').connections, ['subscription', 'api', 'relay']);
  const deepseek = routeOf(snapshot.routes, 'deepseek');
  assert.equal(deepseek.backend, 'pi');
  assert.equal(deepseek.provider, 'deepseek');
  assert.equal(deepseek.source, 'connection');
  assert.deepEqual(deepseek.connections, []);
  // Known route, unknown models: the editor falls back to free text rather than blocking the field.
  assert.deepEqual(deepseek.models, []);
});

test('Claude Code and PI\'s anthropic are separate routes; only Claude\'s names connections', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    connections: () => [SUBSCRIPTION, claudeView('relay')],
    claudeModels: async () => [{ id: 'claude-opus-9', displayName: null, maxInputTokens: null, effortLevels: null }],
    piModels: async () => [{ provider: 'anthropic', model: 'claude-pi-only' }],
  }));
  const anthropic = snapshot.routes.filter((route) => route.endpoint === 'anthropic');
  assert.deepEqual(anthropic.map((route) => [route.backend, route.provider, route.connections]), [
    ['claude', null, ['subscription', 'relay']],
    ['pi', 'anthropic', []],
  ]);
  assert.equal(anthropic[0].models.includes('claude-pi-only'), false, 'PI\'s models stay on PI\'s route');
  assert.deepEqual(anthropic[1].models, ['claude-pi-only']);
});

test('a PI override of anthropic is PI\'s route, never a Claude one', async () => {
  const overrideOnly = await handleModelsCatalog(DEPS, {}, readers({ connections: () => [piOverride('anthropic')] }));
  assert.deepEqual(overrideOnly.routes.map((route) => [route.backend, route.provider, route.source]),
    [['pi', 'anthropic', 'connection']]);
});

test('a Claude connection that serves its own models adds them to the Claude route', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    connections: () => [claudeView('local', { baseUrl: 'http://127.0.0.1:8100', models: ['local-model'] })],
  }));
  const anthropic = routeOf(snapshot.routes, 'anthropic');
  assert.equal(anthropic.source, 'builtin');
  assert.deepEqual(anthropic.connections, ['local']);
  assert.ok(anthropic.models.includes('local-model'));
  assert.ok(anthropic.models.includes(ANTHROPIC_MODELS[0]));
});

test('PI pairs group into one route per provider and dedupe', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    piModels: async () => [
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'deepseek', model: 'deepseek-v4' },
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'openai-codex', model: 'gpt-6-astra' },
    ],
  }));
  const deepseek = routeOf(snapshot.routes, 'deepseek');
  assert.equal(deepseek.source, 'pi');
  assert.deepEqual(deepseek.models, ['deepseek-v4-flash', 'deepseek-v4']);
  // The provider is the connection: a PI route never names one.
  assert.deepEqual(deepseek.connections, []);
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
    piModels: async () => [{ provider: 'my-vllm', model: 'Model-27B' }],
    customProviders: () => ([{
      name: 'my-vllm',
      api: 'anthropic-messages',
      models: [{ id: 'Model-27B' }, { id: 'Model-9B' }],
      upstreamUrl: null,
      hasApiKey: false,
      routed: false,
    }]),
    connections: () => [SUBSCRIPTION, piOverride('my-vllm')],
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

test('a PI model\'s own thinking ladder rides along; the backend ladders are served once', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    piModels: async () => [
      { provider: 'deepseek', model: 'deepseek-v4', thinkingLevels: ['off', 'low', 'high'] },
      // A model whose scan could not tell: absent from the map, so the picker offers the whole
      // backend ladder rather than hiding levels PI would have honoured.
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
    ],
  }));
  const deepseek = routeOf(snapshot.routes, 'deepseek');
  assert.deepEqual(deepseek.modelThinking, { 'deepseek-v4': ['off', 'low', 'high'] });
  assert.equal('deepseek-v4-flash' in deepseek.modelThinking, false);
  assert.ok(snapshot.thinkingLevels.claude.includes('max'));
  assert.ok(snapshot.thinkingLevels.pi.includes('xhigh'));
  assert.ok(snapshot.thinkingLevels.pi.includes('max'));
  assert.deepEqual(routeOf(snapshot.routes, 'anthropic').modelThinking, {});
});

test('a discovered Anthropic model joins the table, with its [1m] variant and effort ladder', async () => {
  const snapshot = await handleModelsCatalog(DEPS, {}, readers({
    claudeModels: async () => [
      {
        id: 'claude-opus-9', displayName: 'Claude Opus 9', maxInputTokens: 1_000_000,
        effortLevels: ['low', 'high'],
      },
      // 200K-only ⇒ no [1m] variant, and a dated snapshot of a shipped alias folds into it.
      { id: 'claude-haiku-4-5-20251001', displayName: null, maxInputTokens: 200_000, effortLevels: null },
    ],
  }));
  const anthropic = routeOf(snapshot.routes, 'anthropic');
  assert.deepEqual(anthropic.models.slice(0, 3),
    ['claude-opus-9', 'claude-opus-9[1m]', 'claude-haiku-4-5-20251001']);
  assert.equal(anthropic.models.includes('claude-haiku-4-5'), false);
  // Everything the table shipped that discovery did not cover is still selectable.
  assert.ok(anthropic.models.includes('claude-opus-5[1m]'));
  assert.deepEqual(anthropic.modelThinking?.['claude-opus-9'], ['low', 'high']);
  assert.deepEqual(anthropic.modelThinking?.['claude-opus-9[1m]'], ['low', 'high']);
  assert.equal('claude-haiku-4-5-20251001' in (anthropic.modelThinking ?? {}), false);
});
