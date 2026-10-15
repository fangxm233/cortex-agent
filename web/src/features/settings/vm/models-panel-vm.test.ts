import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot, ModelCatalogSnapshot, ModelRef } from '@cortex-agent/ui-contract';
import { buildModelFacts, catalogModels, defaultModelOptions, favoriteThinkingControl, modelOptionLabel, thinkingFromValue } from './models-panel-vm';
import { modelKey } from '@/lib/model-selection';

const ref: ModelRef = { backend: 'pi', provider: 'deepseek', model: 'flash' };
const snapshot = { models: { default: { ...ref, thinking: 'high', mode: 'deepseek' },
  favorites: [ref], memory: { [modelKey(ref)]: { thinking: 'xhigh', mode: 'deepseek' } } } } as ConfigSnapshot;
const catalog: ModelCatalogSnapshot = { piPending: false, routes: [
  { backend: 'pi', provider: 'deepseek', endpoint: 'deepseek', modes: ['deepseek'], models: ['flash', 'flash', 'pro'], source: 'pi' },
  { backend: 'claude', provider: null, endpoint: 'anthropic', modes: ['plan'], models: ['opus'], source: 'builtin' },
] };

const copy = { stThinkingBackendDefault: 'Backend default', stThinkingUnsupported: 'unsupported' };
const fact = buildModelFacts(snapshot)[0];
const thinkingCatalog = { ...catalog, thinkingLevels: { pi: ['off', 'low', 'high', 'xhigh'], claude: ['low', 'high', 'max'] } };

function withLevels(levels: string[]): ModelCatalogSnapshot {
  return { ...thinkingCatalog, routes: [{ ...catalog.routes[0], modelThinking: { flash: levels } }] };
}

describe('favorite thinking options', () => {
  it('intersects model capabilities with backend validation, excluding PI max', () => {
    const result = favoriteThinkingControl(fact, withLevels(['off', 'high', 'max']), copy);
    expect(result.disabled).toBe(false);
    expect(result.options).toEqual([
      { value: '', label: 'Backend default' }, { value: 'off', label: 'off' }, { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh · unsupported', disabled: true },
    ]);
    expect(result.value).toBe('xhigh');
  });
  it('falls back only for missing model levels, not explicit empty levels', () => {
    expect(favoriteThinkingControl(fact, thinkingCatalog, copy).options.map(option => option.value))
      .toEqual(['', 'off', 'low', 'high', 'xhigh']);
    expect(favoriteThinkingControl({ ...fact, thinking: null }, withLevels([]), copy).options)
      .toEqual([{ value: '', label: 'Backend default' }]);
  });
  it.each([null, { ...thinkingCatalog, piPending: true }, catalog])('does not guess when capabilities are unavailable: %j', unavailable => {
    const result = favoriteThinkingControl(fact, unavailable, copy);
    expect(result.disabled).toBe(true);
    expect(result.value).toBe('xhigh');
    expect(result.options).toEqual([{ value: '', label: 'Backend default' }, { value: 'xhigh', label: 'xhigh', disabled: true }]);
  });
  it('uses backend and provider identity and keeps Claude available during a PI scan', () => {
    const claude = { ...fact, ref: { backend: 'claude' as const, provider: null, model: 'opus' }, thinking: 'max' };
    const result = favoriteThinkingControl(claude, { ...thinkingCatalog, piPending: true }, copy);
    expect(result.disabled).toBe(false);
    expect(result.options.at(-1)).toEqual({ value: 'max', label: 'max' });
    const anotherProvider = { ...fact, ref: { ...ref, provider: 'other' } };
    expect(favoriteThinkingControl(anotherProvider, withLevels([]), copy).options).toHaveLength(5);
  });
  it('maps backend default to null without conflating off', () => {
    expect(thinkingFromValue('')).toBeNull();
    expect(thinkingFromValue('off')).toBe('off');
    expect(favoriteThinkingControl({ ...fact, thinking: null }, thinkingCatalog, copy).value).toBe('');
  });
});

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
