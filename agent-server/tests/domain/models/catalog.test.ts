import assert from 'node:assert/strict';
import { test } from 'vitest';

import { ANTHROPIC_MODELS } from '../../../src/core/anthropic-models.js';
import type { DiscoveredAnthropicModel } from '../../../src/core/anthropic-model-discovery.js';
import type { PiDiscoveredModel } from '../../../src/agent-adapter/pi/model-scan.js';
import type { ConnectionView } from '../../../src/domain/connections/inventory.js';
import {
  createModelCatalog, findModelRefs, routeFor, servingConnections, thinkingLevelsFor,
  type CatalogRoute, type CatalogSnapshot, type ModelCatalogSources,
} from '../../../src/domain/models/catalog.js';

function claudeView(id: string, overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id, backend: 'claude', provider: null, kind: 'key', label: id, baseUrl: null, billing: 'metered',
    authenticated: true, keyHint: 'sk-…fake', models: null, ...overrides,
  };
}

function piView(provider: string, overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: provider, backend: 'pi', provider, kind: 'override', label: provider,
    baseUrl: 'https://relay.example.test', billing: 'metered', authenticated: true, keyHint: null, models: null,
    ...overrides,
  };
}

const SUBSCRIPTION = claudeView('subscription', { kind: 'subscription', billing: 'subscription', keyHint: null });

interface Fixture {
  connections?: ConnectionView[];
  claude?: DiscoveredAnthropicModel[];
  pi?: PiDiscoveredModel[];
  /** What the PI cache holds before a scan; defaults to `pi`. */
  piPeek?: PiDiscoveredModel[];
}

/** Every source injected: a unit test never asks the live Models API or loads the PI SDK. */
function sources(fixture: Fixture, calls: string[] = []): ModelCatalogSources {
  return {
    connections: () => fixture.connections ?? [SUBSCRIPTION],
    claudeModels: {
      get: () => { calls.push('claude.get'); return fixture.claude ?? []; },
      ensure: async () => { calls.push('claude.ensure'); return fixture.claude ?? []; },
    },
    piModels: {
      peek: () => { calls.push('pi.peek'); return fixture.piPeek ?? fixture.pi ?? []; },
      ensure: async () => { calls.push('pi.ensure'); return fixture.pi ?? []; },
    },
  };
}

function load(fixture: Fixture): Promise<CatalogSnapshot> {
  return createModelCatalog(sources(fixture)).load();
}

function claudeRoute(snapshot: CatalogSnapshot): CatalogRoute {
  const route = routeFor(snapshot, { backend: 'claude', provider: null });
  assert.ok(route, 'expected the Claude route');
  return route;
}

function piRoute(snapshot: CatalogSnapshot, provider: string): CatalogRoute {
  const route = routeFor(snapshot, { backend: 'pi', provider });
  assert.ok(route, `expected a PI route for ${provider}`);
  return route;
}

test('subscription: the Anthropic catalog falls back to the shipped table when the API answers nothing', async () => {
  const route = claudeRoute(await load({}));
  assert.equal(route.source, 'builtin');
  assert.deepEqual(route.models, [...ANTHROPIC_MODELS]);
  assert.deepEqual(route.connections, ['subscription']);
  assert.deepEqual(route.modelConnections, {});
});

test('no Claude connection: no Claude route, and the Models API is never asked', async () => {
  const calls: string[] = [];
  const snapshot = await createModelCatalog(sources({ connections: [piView('deepseek')] }, calls)).load();
  assert.equal(snapshot.routes.some((route) => route.backend === 'claude'), false);
  assert.equal(calls.includes('claude.ensure'), false);
});

test('key connection without models serves the Anthropic catalog alongside the subscription', async () => {
  const route = claudeRoute(await load({ connections: [SUBSCRIPTION, claudeView('api'), claudeView('relay')] }));
  assert.deepEqual(route.connections, ['subscription', 'api', 'relay']);
  assert.deepEqual(route.modelConnections, {}, 'every connection serves every Anthropic model');
  assert.deepEqual(servingConnections(await load({ connections: [SUBSCRIPTION, claudeView('api')] }), ANTHROPIC_MODELS[0]),
    ['subscription', 'api']);
});

test('key connection with models adds them, and only that connection serves them', async () => {
  const local = claudeView('qwen-ksu', { baseUrl: 'http://127.0.0.1:8102', models: ['qwen-coder'] });
  const snapshot = await load({ connections: [SUBSCRIPTION, local] });
  const route = claudeRoute(snapshot);
  assert.ok(route.models.includes('qwen-coder'));
  assert.ok(route.models.includes(ANTHROPIC_MODELS[0]));
  assert.deepEqual(servingConnections(snapshot, 'qwen-coder'), ['qwen-ksu']);
  assert.deepEqual(servingConnections(snapshot, ANTHROPIC_MODELS[0]), ['subscription']);
  // A model nobody lists may run anywhere: the catalog cannot vouch for it either way.
  assert.deepEqual(servingConnections(snapshot, 'typed-by-hand'), ['subscription', 'qwen-ksu']);
});

test('a relay that also lists an Anthropic model is one more option, not the only one', async () => {
  const relay = claudeView('relay', { models: ['claude-opus-5'] });
  const snapshot = await load({ connections: [SUBSCRIPTION, relay, claudeView('api')] });
  assert.deepEqual(servingConnections(snapshot, 'claude-opus-5'), ['subscription', 'relay', 'api']);
  assert.deepEqual(servingConnections(snapshot, 'claude-sonnet-5'), ['subscription', 'api']);
});

test('PI scan: one route per provider, deduplicated, with each model\'s own thinking ladder', async () => {
  const snapshot = await load({
    pi: [
      { provider: 'deepseek', model: 'deepseek-v4', thinkingLevels: ['off', 'low', 'high'] },
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'deepseek', model: 'deepseek-v4' },
      { provider: 'openai-codex', model: 'gpt-6-astra', thinkingLevels: [] },
    ],
  });
  const deepseek = piRoute(snapshot, 'deepseek');
  assert.equal(deepseek.source, 'pi');
  assert.deepEqual(deepseek.models, ['deepseek-v4', 'deepseek-v4-flash']);
  assert.deepEqual(deepseek.connections, ['deepseek'], 'the provider stands for its default login');
  assert.deepEqual(deepseek.modelThinking, { 'deepseek-v4': ['off', 'low', 'high'] });
  assert.deepEqual(piRoute(snapshot, 'openai-codex').modelThinking, { 'gpt-6-astra': [] });
});

test('a PI provider lists its signed-in accounts after its default login; an account adds no route', async () => {
  const work = piView('deepseek-work', { kind: 'account', provider: 'deepseek' });
  const codex = piView('codex-lab', { kind: 'account', provider: 'openai-codex' });
  const snapshot = await load({
    connections: [work, codex], pi: [{ provider: 'deepseek', model: 'deepseek-v4', thinkingLevels: [] }],
  });
  assert.deepEqual(piRoute(snapshot, 'deepseek').connections, ['deepseek', 'deepseek-work']);
  assert.equal(routeFor(snapshot, { backend: 'pi', provider: 'openai-codex' }), undefined);
});

test('custom provider connection: its own models without a scan, labelled custom even once scanned', async () => {
  const custom = piView('my-vllm', { kind: 'custom', api: 'openai-completions', models: ['Model-27B', 'Model-9B'] });
  const cold = await load({ connections: [custom] });
  assert.equal(piRoute(cold, 'my-vllm').source, 'custom');
  assert.deepEqual(piRoute(cold, 'my-vllm').models, ['Model-27B', 'Model-9B']);
  const scanned = await load({ connections: [custom], pi: [{ provider: 'my-vllm', model: 'Model-27B', thinkingLevels: [] }] });
  const route = piRoute(scanned, 'my-vllm');
  assert.equal(route.source, 'custom');
  assert.deepEqual(route.models, ['Model-27B', 'Model-9B']);
  assert.deepEqual(route.modelThinking, { 'Model-27B': [] });
});

test('a PI override alone declares its provider; PI\'s anthropic never joins the Claude route', async () => {
  const snapshot = await load({
    connections: [SUBSCRIPTION, piView('deepseek'), piView('anthropic')],
    pi: [{ provider: 'anthropic', model: 'claude-pi-only' }],
  });
  assert.equal(piRoute(snapshot, 'deepseek').source, 'connection');
  assert.deepEqual(piRoute(snapshot, 'deepseek').models, []);
  assert.deepEqual(piRoute(snapshot, 'anthropic').models, ['claude-pi-only']);
  assert.equal(claudeRoute(snapshot).models.includes('claude-pi-only'), false);
  assert.deepEqual(findModelRefs(snapshot, 'claude-pi-only'), [{ backend: 'pi', provider: 'anthropic', model: 'claude-pi-only' }]);
});

test('thinking levels: the model\'s capability when known, otherwise the backend ladder', async () => {
  const snapshot = await load({
    claude: [{ id: 'claude-opus-9', displayName: null, maxInputTokens: 1_000_000, effortLevels: ['low', 'high'] }],
    pi: [{ provider: 'deepseek', model: 'deepseek-v4-flash', thinkingLevels: [] }],
  });
  assert.deepEqual(thinkingLevelsFor(snapshot, { backend: 'claude', provider: null, model: 'claude-opus-9[1m]' }), ['low', 'high']);
  assert.deepEqual(thinkingLevelsFor(snapshot, { backend: 'claude', provider: null, model: 'claude-sonnet-5' }),
    ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(thinkingLevelsFor(snapshot, { backend: 'pi', provider: 'deepseek', model: 'deepseek-v4-flash' }), []);
  assert.ok(thinkingLevelsFor(snapshot, { backend: 'pi', provider: 'unknown', model: 'x' }).includes('minimal'));
});

test('peek never waits or scans; load waits for both sources; piPending tracks an empty PI answer', async () => {
  const calls: string[] = [];
  const catalog = createModelCatalog(sources({ pi: [{ provider: 'deepseek', model: 'v4' }], piPeek: [] }, calls));
  const peeked = catalog.peek();
  assert.deepEqual(calls, ['claude.get', 'pi.peek']);
  assert.equal(peeked.piPending, true);
  calls.length = 0;
  const loaded = await catalog.load();
  assert.deepEqual(calls.sort(), ['claude.ensure', 'pi.ensure']);
  assert.equal(loaded.piPending, false);
});
