import { describe, expect, it } from 'vitest';
import type { ConfigModels, EngineSelection, ModelCatalogSnapshot, ModelRef } from '@cortex-agent/ui-contract';
import { catalogModels, matchesModelFilter, modelKey, modelLabel, selectionForModel } from './model-selection';

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
  it('restores both remembered fields instead of inheriting the configured default', () => {
    const config = { models: { ...models, memory: { [modelKey(pi)]: { thinking: 'xhigh', connection: null } } } };
    expect(selectionForModel(pi, config, catalog)).toEqual({ ...pi, thinking: 'xhigh', connection: null });
    expect(config.models.default).toEqual(defaultSelection);
  });

  it('preserves remembered null thinking and does not require a loaded catalog', () => {
    const config = { models: { ...models, memory: { [modelKey(claude)]: { thinking: null, connection: 'subscription' } } } };
    expect(selectionForModel(claude, config)).toEqual({ ...claude, thinking: null, connection: 'subscription' });
  });

  it.each([claude, pi])('uses the first matching catalog route for $backend without memory', (ref) => {
    expect(selectionForModel(ref, { models }, catalog)).toEqual({
      ...ref, thinking: null, connection: ref.backend === 'claude' ? 'api' : null,
    });
  });

  it.each([null, undefined])('does not guess a route without memory or catalog (%s)', (config) => {
    expect(selectionForModel(claude, config)).toEqual({ ...claude, thinking: null, connection: null });
    expect(selectionForModel(pi, config)).toEqual({ ...pi, thinking: null, connection: null });
  });

  it('does not borrow memory or a route from another provider with the same model id', () => {
    const other = { ...pi, provider: 'other' };
    const config = { models: { ...models, memory: { [modelKey(pi)]: { thinking: 'high', connection: null } } } };
    expect(selectionForModel(other, config, catalog)).toEqual({ ...other, thinking: null, connection: null });
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
