import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot, ModelCatalogSnapshot, ModelRef } from '@cortex-agent/ui-contract';
import { buildModelFacts, catalogModels, defaultModelOptions, modelOptionLabel } from './models-panel-vm';
import { modelKey } from '@/lib/model-selection';

const ref: ModelRef = { backend: 'pi', provider: 'deepseek', model: 'flash' };
const snapshot = { models: { default: { ...ref, thinking: 'high', mode: 'deepseek' },
  favorites: [ref], memory: { [modelKey(ref)]: { thinking: 'xhigh', mode: 'deepseek' } } } } as ConfigSnapshot;
const catalog: ModelCatalogSnapshot = { piPending: false, routes: [
  { backend: 'pi', provider: 'deepseek', endpoint: 'deepseek', modes: ['deepseek'], models: ['flash', 'flash', 'pro'], source: 'pi' },
  { backend: 'claude', provider: null, endpoint: 'anthropic', modes: ['plan'], models: ['opus'], source: 'builtin' },
] };

describe('model settings derivations', () => {
  it('renders favorites with remembered thinking without loading a catalog', () => {
    expect(buildModelFacts(snapshot)).toEqual([{ ref, key: modelKey(ref), current: true, thinking: 'xhigh' }]);
  });
  it('distinguishes identical model names offered by different providers', () => {
    expect(modelOptionLabel(ref)).toBe('flash · pi · deepseek');
    expect(modelOptionLabel({ ...ref, provider: 'openrouter' })).toBe('flash · pi · openrouter');
  });
  it('deduplicates catalog models by backend/provider/model', () => {
    expect(catalogModels(catalog)).toEqual([ref, { ...ref, model: 'pro' }, { backend: 'claude', provider: null, model: 'opus' }]);
    expect(catalogModels(null)).toEqual([]);
  });
  it('keeps an unfavorited default visible and includes catalog choices', () => {
    const config = { ...snapshot, models: { ...snapshot.models, favorites: [] } };
    expect(defaultModelOptions(config, null)).toEqual([snapshot.models.default]);
    expect(defaultModelOptions(snapshot, catalog)).toHaveLength(3);
  });
});
