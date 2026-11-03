import { describe, expect, it } from 'vitest';
import type {
  AuthAccountStatus, AuthStatusSnapshot, ConfigModels, ConnectionView, EngineSelection, ModelCatalogSnapshot, ModelRef,
} from '@cortex-agent/ui-contract';
import {
  catalogModels, connectionName, connectionNames, defaultConnectionFor, defaultLoginName, hasRoute, matchesModelFilter,
  modelKey, modelLabel, selectionForModel, servingConnections,
} from './model-selection';

const claude: ModelRef = { backend: 'claude', provider: null, model: 'claude-opus-5' };
const pi: ModelRef = { backend: 'pi', provider: 'deepseek', model: 'deepseek-v4-flash' };
const catalog: ModelCatalogSnapshot = {
  routes: [
    { endpoint: 'anthropic', backend: 'claude', provider: null, connections: ['api', 'subscription'], models: [claude.model, 'claude-sonnet-5'], source: 'builtin', modelThinking: {} },
    { endpoint: 'deepseek', backend: 'pi', provider: 'deepseek', connections: [], models: [pi.model], source: 'pi', modelThinking: {} },
  ],
  thinkingLevels: { claude: ['low', 'high'], pi: ['off', 'high'] }, piPending: false,
};
const defaultSelection: EngineSelection = { ...claude, thinking: 'high', connection: 'subscription' };
const models: ConfigModels = { default: defaultSelection, favorites: [claude, pi], memory: {} };

describe('model identity and labels', () => {
  it('uses the server tuple format, distinguishing backend and provider', () => {
    expect(modelKey(claude)).toBe('["claude",null,"claude-opus-5"]');
    expect(new Set([
      modelKey(claude), modelKey({ ...claude, backend: 'pi' }),
      modelKey({ ...claude, provider: 'other' }),
    ]).size).toBe(3);
    expect(JSON.parse(modelKey({ ...pi, model: 'a,"b' }))).toEqual(['pi', 'deepseek', 'a,"b']);
  });

  it('shortens Claude names and date suffixes without removing model versions', () => {
    expect(modelLabel({ ...claude, model: 'claude-sonnet-4-20250514' })).toBe('sonnet-4');
    expect(modelLabel(pi)).toBe('deepseek-v4-flash');
  });
});

describe('selectionForModel', () => {
  it('restores the remembered thinking instead of inheriting the configured default', () => {
    const config = { models: { ...models, memory: { [modelKey(pi)]: { thinking: 'xhigh' } } } };
    expect(selectionForModel(pi, config, catalog)).toEqual({ ...pi, thinking: 'xhigh', connection: null });
    expect(config.models.default).toEqual(defaultSelection);
  });

  it('preserves remembered null thinking and does not require a loaded catalog', () => {
    const config = { models: { ...models, memory: { [modelKey(claude)]: { thinking: null } } } };
    expect(selectionForModel(claude, config)).toEqual({ ...claude, thinking: null, connection: null });
  });

  it.each([claude, pi])('names no connection for $backend when nothing carries one: the run computes it', (ref) => {
    expect(selectionForModel(ref, { models }, catalog)).toEqual({ ...ref, thinking: null, connection: null });
  });

  it('keeps the current connection while it serves the new model, and drops it otherwise', () => {
    const current = { ...defaultSelection, model: 'claude-sonnet-5', connection: 'api' };
    expect(selectionForModel(claude, { models }, catalog, current).connection).toBe('api');
    const listed = { ...catalog, routes: [{ ...catalog.routes[0], modelConnections: { [claude.model]: ['subscription'] } }] };
    expect(selectionForModel(claude, { models }, listed, current).connection).toBeNull();
    // Without a catalog nothing shows the connection serves the model.
    expect(selectionForModel(claude, { models }, null, current).connection).toBeNull();
    expect(selectionForModel(pi, { models }, catalog, current).connection).toBeNull();
  });

  it('keeps a PI account across models of its provider, never on another provider', () => {
    const accounts = { ...catalog, routes: [catalog.routes[0], { ...catalog.routes[1], connections: ['deepseek', 'deepseek-work'] }] };
    const current = { ...pi, model: 'deepseek-v4-pro', thinking: null, connection: 'deepseek-work' };
    expect(selectionForModel(pi, { models }, accounts, current).connection).toBe('deepseek-work');
    expect(selectionForModel({ ...pi, provider: 'other' }, { models }, accounts, current).connection).toBeNull();
    expect(selectionForModel(pi, { models }, catalog, current).connection).toBeNull();
  });

  it.each([null, undefined])('does not guess a route without memory or catalog (%s)', (config) => {
    expect(selectionForModel(claude, config)).toEqual({ ...claude, thinking: null, connection: null });
    expect(selectionForModel(pi, config)).toEqual({ ...pi, thinking: null, connection: null });
  });

  it('does not borrow memory from another provider with the same model id', () => {
    const other = { ...pi, provider: 'other' };
    const config = { models: { ...models, memory: { [modelKey(pi)]: { thinking: 'high' } } } };
    expect(selectionForModel(other, config, catalog)).toEqual({ ...other, thinking: null, connection: null });
  });
});

describe('serving and default connections', () => {
  const local = { ...catalog, routes: [{ ...catalog.routes[0], connections: ['subscription', 'api', 'qwen'],
    models: [...catalog.routes[0].models, 'qwen-coder'], modelConnections: { 'qwen-coder': ['qwen'] } }, catalog.routes[1]] };

  it('serves a listed model only on its own connections, every other on all of them', () => {
    expect(servingConnections(local, { ...claude, model: 'qwen-coder' })).toEqual(['qwen']);
    expect(servingConnections(local, claude)).toEqual(['subscription', 'api', 'qwen']);
    expect(servingConnections(null, claude)).toEqual([]);
  });

  it('serves a PI model on the provider\'s default login, then on each of its accounts', () => {
    const accounts = { ...catalog, routes: [catalog.routes[0], { ...catalog.routes[1], connections: ['deepseek', 'deepseek-work'] }] };
    expect(servingConnections(accounts, pi)).toEqual(['deepseek', 'deepseek-work']);
    expect(defaultConnectionFor(accounts, pi)).toBe('deepseek');
    // An older server lists no PI connections; a provider the catalog lacks still has its login.
    expect(servingConnections(local, pi)).toEqual(['deepseek']);
    expect(servingConnections(null, pi)).toEqual(['deepseek']);
  });

  it('runs on the default connection when it serves the model, else the first that does', () => {
    expect(defaultConnectionFor(local, claude)).toBe('subscription');
    expect(defaultConnectionFor(local, { ...claude, model: 'qwen-coder' })).toBe('qwen');
    expect(defaultConnectionFor(null, claude)).toBeNull();
  });

  it('counts a Claude model runnable only when a connection serves it', () => {
    expect(hasRoute({ ...claude, thinking: null, connection: null }, local)).toBe(true);
    expect(hasRoute({ ...claude, thinking: null, connection: null }, { ...catalog, routes: [catalog.routes[1]] })).toBe(false);
    expect(hasRoute({ ...pi, thinking: null, connection: null }, null)).toBe(true);
  });
});

describe('catalogModels', () => {
  it('flattens routes into complete references, retaining backend and provider', () => {
    expect(catalogModels(catalog)).toEqual([claude, { ...claude, model: 'claude-sonnet-5' }, pi]);
  });

  it('does not conflate the same model name on different providers', () => {
    const duplicate = { ...catalog.routes[1], provider: 'other' };
    expect(catalogModels({ ...catalog, routes: [catalog.routes[1], duplicate] }))
      .toEqual([pi, { ...pi, provider: 'other' }]);
  });

  it('returns no rows before the catalog loads', () => {
    expect(catalogModels(null)).toEqual([]);
    expect(catalogModels()).toEqual([]);
  });
});

describe('shared model filter', () => {
  it('uses the same trimmed case-insensitive substring match on both surfaces', () => {
    expect(matchesModelFilter('Claude-Opus-5', ' OPUS ')).toBe(true);
    expect(matchesModelFilter('Claude-Opus-5', '')).toBe(true);
    expect(matchesModelFilter('Claude-Opus-5', 'sonnet')).toBe(false);
  });
});

describe('connection names', () => {
  const view = (fields: Partial<ConnectionView>): ConnectionView => ({
    id: 'x', backend: 'claude', provider: null, kind: 'key', label: 'x', baseUrl: null, billing: 'metered',
    authenticated: true, keyHint: null, models: null, ...fields,
  });
  const views = [
    view({ id: 'subscription', kind: 'subscription', label: 'Claude subscription', billing: 'subscription' }),
    view({ id: 'school', kind: 'account', label: 'School', billing: 'subscription' }),
    view({ id: 'relay', label: 'Team relay' }),
  ];
  const row = (fields: Partial<AuthAccountStatus>) => ({
    backend: 'claude', provider: 'anthropic', connection: null, isDefault: true, label: 'Anthropic', identity: null, ...fields,
  }) as AuthAccountStatus;
  const status = (...accounts: AuthAccountStatus[]) => ({ accounts }) as unknown as AuthStatusSnapshot;

  it('names accounts by label and the default login by the name given; other connections keep their id', () => {
    const names = connectionNames(views, 'me@home.com');
    expect(['subscription', 'school', 'relay'].map(id => connectionName(names, id))).toEqual(['me@home.com', 'School', 'relay']);
    expect(connectionName(connectionNames(views), 'subscription')).toBe('subscription');
  });

  it('keeps each backend\'s names apart: an account id is unique only within its backend', () => {
    const both = [
      view({ id: 'lab', kind: 'account', label: 'Lab', billing: 'subscription' }),
      view({ id: 'lab', backend: 'pi', provider: 'openai', kind: 'account', label: 'LAB key' }),
    ];
    expect(connectionNames(both, undefined, 'claude')).toEqual({ lab: 'Lab' });
    expect(connectionNames(both, undefined, 'pi')).toEqual({ lab: 'LAB key' });
  });

  it('names the default login by its email, else by the fallback', () => {
    const named = status(row({ identity: { email: 'me@home.com', organization: null, plan: 'claude_max' } }),
      row({ connection: 'school', isDefault: false, identity: { email: 'me@school.edu', organization: null, plan: null } }));
    expect(defaultLoginName(named, 'Claude subscription')).toBe('me@home.com');
    expect(defaultLoginName(status(row({})), 'Claude subscription')).toBe('Claude subscription');
    expect(defaultLoginName(status(row({ backend: 'pi', provider: 'openai', identity: { email: 'pi@x.com', organization: null, plan: null } })), 'Claude subscription'))
      .toBe('Claude subscription');
    expect(defaultLoginName(undefined, 'Claude subscription')).toBe('Claude subscription');
  });
});
