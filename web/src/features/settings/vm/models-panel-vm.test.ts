import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot, ModelCatalogSnapshot, ModelRef } from '@cortex-agent/ui-contract';
import {
  buildModelFacts, catalogModels, defaultConnectionControl, defaultModelOptions, delegationMode, favoriteThinkingControl,
  modelOptionLabel, parsePatterns, policyWithMode, thinkingFromValue,
} from './models-panel-vm';
import { modelKey } from '@/lib/model-selection';

const ref: ModelRef = { backend: 'pi', provider: 'deepseek', model: 'flash' };
const snapshot = { models: { default: { ...ref, thinking: 'high', connection: null },
  favorites: [ref], memory: { [modelKey(ref)]: { thinking: 'xhigh' } } } } as ConfigSnapshot;
const catalog: ModelCatalogSnapshot = { piPending: false, routes: [
  { backend: 'pi', provider: 'deepseek', endpoint: 'deepseek', connections: [], models: ['flash', 'flash', 'pro'], source: 'pi' },
  { backend: 'claude', provider: null, endpoint: 'anthropic', connections: ['subscription'], models: ['opus'], source: 'builtin' },
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

describe('default connection', () => {
  const opus = { backend: 'claude' as const, provider: null, model: 'opus' };
  const accounts: ModelCatalogSnapshot = { piPending: false, routes: [
    { backend: 'claude', provider: null, endpoint: 'anthropic', connections: ['subscription', 'school'], models: ['opus'], source: 'builtin' },
  ] };
  const onDefault = { models: { default: { ...opus, thinking: null, connection: null }, favorites: [], memory: {} } } as unknown as ConfigSnapshot;

  it('offers the connections serving the default model, accounts by their label', () => {
    const control = defaultConnectionControl(onDefault, accounts, { school: 'School' }, { withConnection: 'Default ({connection})', plain: 'Default' });
    expect(control).toEqual({
      value: '',
      options: [
        { value: '', label: 'Default (subscription)' },
        { value: 'subscription', label: 'subscription' },
        { value: 'school', label: 'School' },
      ],
    });
    const pinned = { models: { ...onDefault.models, default: { ...opus, thinking: null, connection: 'school' } } } as ConfigSnapshot;
    expect(defaultConnectionControl(pinned, accounts, {}, { withConnection: 'Default ({connection})', plain: 'Default' })?.value).toBe('school');
  });

  it('offers a PI default model\'s accounts beside a plain Default', () => {
    const flash = { backend: 'pi' as const, provider: 'deepseek', model: 'flash' };
    const pi: ModelCatalogSnapshot = { piPending: false, routes: [
      { backend: 'pi', provider: 'deepseek', endpoint: 'deepseek', connections: ['deepseek', 'ds-work'], models: ['flash'], source: 'pi' },
    ] };
    const config = { models: { default: { ...flash, thinking: null, connection: null }, favorites: [], memory: {} } } as unknown as ConfigSnapshot;
    expect(defaultConnectionControl(config, pi, { 'ds-work': 'Work' }, { withConnection: 'Default ({connection})', plain: 'Default' }))
      .toEqual({ value: '', options: [{ value: '', label: 'Default' }, { value: 'ds-work', label: 'Work' }] });
  });

  it('offers nothing when one connection or none serves the default model', () => {
    expect(defaultConnectionControl(onDefault, catalog, {}, { withConnection: 'Default ({connection})', plain: 'Default' })).toBeNull();
    expect(defaultConnectionControl(snapshot, accounts, {}, { withConnection: 'Default ({connection})', plain: 'Default' })).toBeNull();
    expect(defaultConnectionControl(onDefault, null, {}, { withConnection: 'Default ({connection})', plain: 'Default' })).toBeNull();
  });
});

describe('delegation policy controls', () => {
  it('reads the mode and seeds custom patterns from the configured models', () => {
    const configured = { models: { ...snapshot.models,
      favorites: [ref, { backend: 'claude', provider: null, model: 'opus' }] } } as ConfigSnapshot;
    expect(delegationMode({ allow: 'favorites', deny: [] })).toBe('favorites');
    expect(delegationMode({ allow: ['a*'], deny: [] })).toBe('custom');
    expect(policyWithMode({ allow: 'favorites', deny: ['x'] }, 'custom', configured))
      .toEqual({ allow: ['deepseek/flash', 'opus'], deny: ['x'] });
    expect(policyWithMode({ allow: ['a*'], deny: [] }, 'custom', configured)).toEqual({ allow: ['a*'], deny: [] });
    expect(policyWithMode({ allow: ['a*'], deny: ['x'] }, 'all', configured)).toEqual({ allow: 'all', deny: ['x'] });
  });

  it('splits typed patterns on commas and whitespace', () => {
    expect(parsePatterns(' openai/*-pro,claude-opus-*  openai/*-pro ,, ')).toEqual(['openai/*-pro', 'claude-opus-*']);
    expect(parsePatterns('')).toEqual([]);
  });
});
