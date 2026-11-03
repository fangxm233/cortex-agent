import { describe, expect, test, vi } from 'vitest';

vi.mock('@core/log.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import type { EngineSelection, ModelRef } from '../../../src/domain/agents/engine-selection.js';
import type { ModelMemory } from '../../../src/domain/agents/agent-state.js';
import {
  effectiveSelection, resolveSelection, type SelectionContext,
} from '../../../src/domain/agents/resolve-selection.js';
import type { ConnectionView, CredentialInventory } from '../../../src/domain/connections/inventory.js';
import { routeName, spawnRouteName } from '../../../src/domain/connections/index.js';
import { createModelCatalog } from '../../../src/domain/models/catalog.js';

function claudeView(id: string, models: string[] | null = null): ConnectionView {
  return {
    id, backend: 'claude', provider: null, kind: id === 'subscription' ? 'subscription' : 'key', label: id,
    baseUrl: null, billing: id === 'subscription' ? 'subscription' : 'metered', authenticated: true, keyHint: null, models,
  };
}

function piAccountView(id: string, provider: string): ConnectionView {
  return {
    id, backend: 'pi', provider, kind: 'account', label: id, baseUrl: null, billing: 'metered',
    authenticated: true, keyHint: null, models: null,
  };
}

/** The host: a subscription, an API key, a local endpoint that serves its own model, and a second
 *  DeepSeek account. */
const HOST = [
  claudeView('subscription'), claudeView('api'), claudeView('qwen-ksu', ['qwen-coder']),
  piAccountView('deepseek-work', 'deepseek'),
];

function inventoryOf(views: ConnectionView[]): CredentialInventory {
  const claude = views.filter((view) => view.backend === 'claude');
  return {
    list: () => views,
    claudeConnections: () => claude,
    piConnections: () => [],
    findClaude: (id) => claude.find((view) => view.id === id) ?? null,
    findPi: () => null,
    piAccounts: (provider) => views.filter((view) => view.kind === 'account' && view.backend === 'pi'
      && (provider === undefined || view.provider === provider)),
    accounts: () => [],
    hasClaude: () => claude.length > 0,
    claudeSubscriptionSource: () => (claude.some((view) => view.id === 'subscription') ? 'claude-store' : null),
    defaultClaudeConnection: () => claude[0]?.id ?? null,
    billingOf: () => 'metered',
  };
}

function catalogOf(views: ConnectionView[]) {
  return () => createModelCatalog({
    connections: () => views,
    claudeModels: {
      get: () => [
        { id: 'claude-opus-5', displayName: null, maxInputTokens: null, effortLevels: ['low', 'high'] },
        { id: 'claude-sonnet-5', displayName: null, maxInputTokens: null, effortLevels: null },
      ],
      ensure: async () => [],
    },
    piModels: {
      peek: () => [{ provider: 'deepseek', model: 'v4', thinkingLevels: ['off', 'high'] }, { provider: 'deepseek', model: 'v4-chat', thinkingLevels: [] }],
      ensure: async () => [],
    },
  }).peek();
}

const OPUS: EngineSelection = { backend: 'claude', provider: null, model: 'claude-opus-5', thinking: 'high', connection: null };
const SONNET: EngineSelection = { backend: 'claude', provider: null, model: 'claude-sonnet-5', thinking: null, connection: 'api' };
const PI_V4: ModelRef = { backend: 'pi', provider: 'deepseek', model: 'v4' };

interface Case {
  name: string;
  layers?: Partial<Pick<SelectionContext, 'request' | 'session' | 'draft'>>;
  partial?: Partial<EngineSelection>;
  hostViews?: ConnectionView[];
  configured?: EngineSelection | null;
  memory?: ModelMemory;
  expect: Partial<EngineSelection> & { effectiveConnection?: string | null }
    | { reason: string; allowed?: readonly string[] };
}

function contextFor(entry: Case): SelectionContext {
  const views = entry.hostViews ?? HOST;
  const configured = entry.configured === undefined ? OPUS : entry.configured;
  return {
    ...entry.layers,
    defaults: {
      selection: () => configured,
      forBackend: (backend) => (backend === 'pi' ? PI_V4 : configured),
    },
    memory: () => entry.memory ?? {},
    inventory: inventoryOf(views),
    catalog: catalogOf(views),
  };
}

const CASES: Case[] = [
  // ── Layers ───────────────────────────────────────────────────────────────
  { name: 'default: nothing else known', expect: { model: 'claude-opus-5', thinking: 'high', connection: null, effectiveConnection: 'subscription' } },
  { name: 'draft beats the default', layers: { draft: SONNET }, expect: { model: 'claude-sonnet-5', connection: 'api' } },
  {
    name: 'session beats the draft once it exists',
    layers: { session: { ...SONNET, model: 'claude-opus-5', thinking: 'low' }, draft: SONNET },
    expect: { model: 'claude-opus-5', thinking: 'low', connection: 'api' },
  },
  {
    name: 'a carried request beats the session',
    layers: { request: { ...OPUS, thinking: null }, session: SONNET },
    expect: { model: 'claude-opus-5', thinking: null, connection: null },
  },
  {
    name: 'explicit fields beat every layer and the rest is inherited',
    layers: { session: SONNET }, partial: { thinking: 'xhigh' },
    expect: { model: 'claude-sonnet-5', thinking: 'xhigh', connection: 'api' },
  },
  { name: 'no default configured and nothing else: nothing to run', configured: null, expect: { reason: 'no-model-for-backend' } },
  // ── Model changes ────────────────────────────────────────────────────────
  {
    name: 'a new model takes its remembered thinking',
    layers: { session: OPUS }, partial: { model: 'claude-sonnet-5' },
    memory: { '["claude",null,"claude-sonnet-5"]': { thinking: 'medium' } },
    expect: { model: 'claude-sonnet-5', thinking: 'medium' },
  },
  {
    name: 'old model memory that still carries a connection: only thinking is used',
    layers: { session: OPUS }, partial: { model: 'claude-sonnet-5' },
    memory: { '["claude",null,"claude-sonnet-5"]': { thinking: 'low', connection: 'api' } as never },
    expect: { thinking: 'low', connection: null, effectiveConnection: 'subscription' },
  },
  {
    name: 'a backend pick takes that backend\'s starting point',
    layers: { session: OPUS }, partial: { backend: 'pi' },
    memory: { '["pi","deepseek","v4"]': { thinking: 'high' } },
    expect: { backend: 'pi', provider: 'deepseek', model: 'v4', thinking: 'high', connection: null },
  },
  {
    name: 'a backend-only pick takes the configured default whole, not the model\'s memory',
    layers: { session: { ...PI_V4, thinking: null, connection: null } }, partial: { backend: 'claude' },
    memory: { '["claude",null,"claude-opus-5"]': { thinking: 'low' } },
    expect: { backend: 'claude', model: 'claude-opus-5', thinking: 'high' },
  },
  {
    name: 'a cross-backend pick that names the model takes the model\'s remembered thinking',
    layers: { session: { ...PI_V4, thinking: null, connection: null } }, partial: { backend: 'claude', model: 'claude-opus-5' },
    memory: { '["claude",null,"claude-opus-5"]': { thinking: 'low' } },
    expect: { backend: 'claude', model: 'claude-opus-5', thinking: 'low' },
  },
  // ── Thinking ─────────────────────────────────────────────────────────────
  {
    name: 'explicit thinking the model does not accept is refused with its own levels',
    layers: { session: OPUS }, partial: { thinking: 'max' },
    expect: { reason: 'invalid-thinking', allowed: ['low', 'high'] },
  },
  {
    name: 'a model without capability data accepts the backend ladder',
    layers: { session: SONNET }, partial: { thinking: 'max' }, expect: { thinking: 'max' },
  },
  {
    name: 'remembered thinking the new model does not accept drops to its default',
    layers: { session: SONNET }, partial: { model: 'claude-opus-5' },
    memory: { '["claude",null,"claude-opus-5"]': { thinking: 'max' } },
    expect: { model: 'claude-opus-5', thinking: null },
  },
  {
    name: 'a non-reasoning PI model takes no level',
    layers: { session: { ...PI_V4, thinking: null, connection: null } }, partial: { model: 'v4-chat', thinking: 'high' },
    expect: { reason: 'invalid-thinking', allowed: [] },
  },
  // ── Connections ──────────────────────────────────────────────────────────
  {
    name: 'an explicit connection that does not exist is refused',
    layers: { session: OPUS }, partial: { connection: 'gone' },
    expect: { reason: 'invalid-connection', allowed: ['subscription', 'api', 'qwen-ksu'] },
  },
  {
    name: 'an explicit null connection returns the choice to the computed one',
    layers: { session: SONNET }, partial: { connection: null },
    expect: { connection: null, effectiveConnection: 'subscription' },
  },
  {
    name: 'a carried connection that was removed falls back without an error',
    layers: { session: { ...SONNET, connection: 'gone' } },
    expect: { connection: null, effectiveConnection: 'subscription' },
  },
  {
    name: 'repeating a removed connection the selection already had is not a new request',
    layers: { session: { ...SONNET, connection: 'gone' } }, partial: { ...SONNET, connection: 'gone', thinking: 'low' },
    expect: { thinking: 'low', connection: null },
  },
  {
    name: 'a carried connection that does not serve the new model is dropped; the model\'s own runs it',
    layers: { session: SONNET }, partial: { model: 'qwen-coder' },
    expect: { model: 'qwen-coder', connection: null, effectiveConnection: 'qwen-ksu' },
  },
  {
    name: 'a carried connection that serves the new model is kept',
    layers: { session: SONNET }, partial: { model: 'claude-opus-5' },
    expect: { connection: 'api', effectiveConnection: 'api' },
  },
  {
    name: 'the default connection runs a general model even when a relay comes first in the file',
    hostViews: [claudeView('subscription'), claudeView('relay', ['claude-opus-5']), claudeView('api')],
    expect: { connection: null, effectiveConnection: 'subscription' },
  },
  {
    name: 'without the default connection serving it, the first serving connection runs the model',
    hostViews: [claudeView('api'), claudeView('qwen-ksu', ['qwen-coder'])],
    layers: { session: OPUS }, partial: { model: 'qwen-coder' },
    expect: { effectiveConnection: 'qwen-ksu' },
  },
  {
    name: 'a host with no Claude connection computes none',
    hostViews: [],
    expect: { connection: null, effectiveConnection: null },
  },
  {
    name: 'PI: a connection that is not one of the provider\'s accounts is refused',
    layers: { session: { ...PI_V4, thinking: null, connection: null } }, partial: { connection: 'api' },
    expect: { reason: 'invalid-connection', allowed: ['deepseek', 'deepseek-work'] },
  },
  {
    name: 'PI: naming one of the provider\'s accounts runs on it',
    layers: { session: { ...PI_V4, thinking: null, connection: null } }, partial: { connection: 'deepseek-work' },
    expect: { backend: 'pi', connection: 'deepseek-work', effectiveConnection: 'deepseek-work' },
  },
  {
    name: 'PI: naming the provider itself is its default login, stored as null',
    layers: { session: { ...PI_V4, thinking: null, connection: 'deepseek-work' } }, partial: { connection: 'deepseek' },
    expect: { connection: null, effectiveConnection: null },
  },
  {
    name: 'PI: the account carries over to another model of the same provider',
    layers: { session: { ...PI_V4, thinking: null, connection: 'deepseek-work' } }, partial: { model: 'v4-chat' },
    expect: { model: 'v4-chat', connection: 'deepseek-work' },
  },
  {
    name: 'PI: an account no longer signed in falls back to the default login without an error',
    layers: { session: { ...PI_V4, thinking: null, connection: 'deepseek-old' } },
    expect: { connection: null, effectiveConnection: null },
  },
  {
    name: 'PI: another provider does not inherit the account',
    layers: { session: { ...PI_V4, thinking: null, connection: 'deepseek-work' } }, partial: { provider: 'openai', model: 'gpt-5' },
    expect: { provider: 'openai', connection: null },
  },
  // ── Identity ─────────────────────────────────────────────────────────────
  { name: 'Claude takes no provider', partial: { provider: 'deepseek' }, expect: { reason: 'provider-not-supported' } },
  { name: 'an empty model is refused', partial: { model: '' }, expect: { reason: 'invalid-model' } },
];

describe('resolveSelection', () => {
  test.each(CASES)('$name', (entry) => {
    const resolution = resolveSelection(contextFor(entry), entry.partial ?? {});
    if ('reason' in entry.expect) {
      expect(resolution).toMatchObject({ ok: false, ...entry.expect });
      return;
    }
    expect(resolution.ok).toBe(true);
    if (resolution.ok !== true) return;
    const { effectiveConnection, ...fields } = entry.expect;
    expect(resolution.selection).toMatchObject(fields);
    if (effectiveConnection !== undefined) expect(resolution.effective.connection).toBe(effectiveConnection);
    expect({ ...resolution.effective, connection: resolution.selection.connection }).toEqual(resolution.selection);
  });
});

test('effectiveSelection computes a stored selection\'s connection by the same rule', () => {
  const context = { inventory: inventoryOf(HOST), catalog: catalogOf(HOST) };
  expect(effectiveSelection({ ...OPUS, model: 'qwen-coder' }, context).connection).toBe('qwen-ksu');
  expect(effectiveSelection({ ...OPUS, connection: 'api' }, context).connection).toBe('api');
  expect(effectiveSelection({ ...OPUS, connection: 'gone' }, context).connection).toBe('subscription');
});

test('routeName files a Claude selection naming no connection under the one its run uses', () => {
  const context = { inventory: inventoryOf(HOST), catalog: catalogOf(HOST) };
  expect(routeName({ ...OPUS, model: 'qwen-coder' }, context)).toBe('qwen-ksu');
  expect(routeName(OPUS, context)).toBe('subscription');
  expect(routeName({ ...OPUS, connection: 'api' }, context)).toBe('api');
  expect(routeName({ ...PI_V4, connection: null }, context)).toBe('deepseek');
  expect(routeName({ ...PI_V4, connection: 'deepseek-work' }, context)).toBe('deepseek-work');
  expect(routeName(OPUS, { inventory: inventoryOf([]), catalog: catalogOf([]) })).toBe('subscription');
});

test('spawnRouteName files a spawn under the connection its Claude route was resolved for', () => {
  const route = { connection: 'api' };
  expect(spawnRouteName(OPUS, route)).toBe('api');
  expect(spawnRouteName({ ...PI_V4, connection: null }, route)).toBe('deepseek');
});
