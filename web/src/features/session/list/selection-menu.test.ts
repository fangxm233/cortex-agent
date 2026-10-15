import { describe, expect, it } from 'vitest';
import type { ConfigAgentEntry, ConfigModels, EngineSelection, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import { modelKey } from '@/lib/model-selection';
import {
  agentChange, agentChipParts, agentRowSub, buildAgentOptions, buildFavoriteOptions,
  buildModeOptions, buildModelOptions, buildThinkingOptions, groupModelOptions, hasAgentChoice,
  modeChange, modelChange, selectionChipParts, selectionRootRows, thinkingChange,
} from './selection-menu';

const current: EngineSelection = { backend: 'claude', provider: null, model: 'claude-opus-5', thinking: 'high', mode: 'plan' };
const sonnet: EngineSelection = { ...current, model: 'claude-sonnet-5', thinking: 'low', mode: 'api' };
const pi: EngineSelection = { backend: 'pi', provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'xhigh', mode: 'deepseek' };
const models: ConfigModels = {
  default: current,
  favorites: [current, sonnet, pi].map(({ backend, provider, model }) => ({ backend, provider, model })),
  memory: {
    [modelKey(sonnet)]: { thinking: 'low', mode: 'api' },
    [modelKey(pi)]: { thinking: 'xhigh', mode: 'deepseek' },
  },
};
const catalog: ModelCatalogSnapshot = {
  routes: [
    { endpoint: 'anthropic', backend: 'claude', provider: null, modes: ['plan', 'api'],
      models: [current.model, sonnet.model], source: 'builtin', modelThinking: {} },
    { endpoint: 'deepseek', backend: 'pi', provider: 'deepseek', modes: ['deepseek'],
      models: [pi.model], source: 'pi', modelThinking: { [pi.model]: ['high', 'xhigh'] } },
    { endpoint: 'other', backend: 'pi', provider: 'other', modes: ['other'],
      models: [pi.model, 'another-model'], source: 'pi', modelThinking: {} },
  ],
  thinkingLevels: { claude: ['low', 'high', 'max'], pi: ['off', 'low', 'high'] }, piPending: false,
};

function options(hasHistory = false, selection = current) {
  return buildModelOptions(catalog, models, selection, { hasHistory });
}

describe('favorite and catalog options', () => {
  it('renders favorites with identity and remembered thinking/route without a catalog', () => {
    const favorites = buildFavoriteOptions(models, current, { hasHistory: false });
    expect(favorites.map((option) => [option.id, option.backend, option.provider, option.favorite])).toEqual([
      [current.model, 'claude', null, true], [sonnet.model, 'claude', null, true], [pi.model, 'pi', 'deepseek', true],
    ]);
    expect(favorites[1].selection).toEqual(sonnet);
    expect(favorites[2].selection).toEqual(pi);
    expect(favorites[0]).toMatchObject({ active: true, selection: { thinking: null, mode: '' } });
  });

  it('returns empty lists while configuration/catalog is unavailable', () => {
    expect(buildFavoriteOptions(null, current, { hasHistory: false })).toEqual([]);
    expect(buildModelOptions(null, models, current, { hasHistory: false })).toEqual([]);
    expect(buildModelOptions(undefined, models, current, { hasHistory: false })).toEqual([]);
  });

  it('matches active and favorite models by provider as well as model id', () => {
    const entries = options(false, pi).filter((option) => option.id === pi.model);
    expect(entries.map(({ provider, active, favorite }) => ({ provider, active, favorite }))).toEqual([
      { provider: 'deepseek', active: true, favorite: true },
      { provider: 'other', active: false, favorite: false },
    ]);
  });

  it('allows catalog models without favorites or configuration', () => {
    const entries = buildModelOptions(catalog, null, current, { hasHistory: false });
    expect(entries).toHaveLength(5);
    expect(entries.every((option) => !option.disabled && !option.favorite && option.disabledReason === null)).toBe(true);
    expect(entries[2].selection).toEqual({ ...pi, thinking: null });
  });

  it('keeps cross-backend rows visible but disabled for live sessions in both lists', () => {
    const lists = [options(true), buildFavoriteOptions(models, current, { hasHistory: true })];
    for (const entries of lists) {
      expect(entries.find((option) => option.id === sonnet.model)).toMatchObject({ disabled: false, disabledReason: null });
      expect(entries.find((option) => option.backend === 'pi')).toMatchObject({ disabled: true, disabledReason: 'cross-backend' });
    }
    expect(options(false).every((option) => !option.disabled)).toBe(true);
  });

  it('allows provider changes inside a live PI session but disables Claude', () => {
    const entries = options(true, pi);
    expect(entries.filter((option) => option.backend === 'pi').every((option) => !option.disabled)).toBe(true);
    expect(entries[0]).toMatchObject({ disabled: true, disabledReason: 'cross-backend' });
  });

  it('groups providers with the current backend first and preserves order inside each group', () => {
    const groups = groupModelOptions(options(false, pi), 'pi');
    expect(groups.map(({ group, backend }) => [group, backend])).toEqual([
      ['deepseek', 'pi'], ['other', 'pi'], ['claude', 'claude'],
    ]);
    expect(groups[1].options.map((option) => option.id)).toEqual([pi.model, 'another-model']);
  });
});

describe('thinking and mode options', () => {
  it('prepends an explicit backend-default thinking choice', () => {
    expect(buildThinkingOptions(catalog, current)).toEqual([
      { level: null, active: false }, { level: 'low', active: false },
      { level: 'high', active: true }, { level: 'max', active: false },
    ]);
    expect(buildThinkingOptions(null, { ...current, thinking: null })).toEqual([{ level: null, active: true }]);
  });

  it('prefers model-specific levels and otherwise uses backend levels', () => {
    expect(buildThinkingOptions(catalog, pi).map((option) => option.level)).toEqual([null, 'high', 'xhigh']);
    expect(buildThinkingOptions(catalog, { ...pi, provider: 'other' }).map((option) => option.level))
      .toEqual([null, 'off', 'low', 'high']);
  });

  it('does not substitute backend levels for an explicitly empty model list', () => {
    const restricted = { ...catalog, routes: [{ ...catalog.routes[0], modelThinking: { [current.model]: [] } }] };
    expect(buildThinkingOptions(restricted, current)).toEqual([{ level: null, active: false }]);
  });

  it('only offers mode choice when the matching route has multiple modes', () => {
    expect(buildModeOptions(catalog, current)).toEqual([{ mode: 'plan', active: true }, { mode: 'api', active: false }]);
    expect(buildModeOptions(catalog, pi)).toEqual([]);
    expect(buildModeOptions(null, current)).toEqual([]);
  });
});

describe('complete selection changes', () => {
  it('replaces the entire selection with the picked model memory on either backend', () => {
    expect(modelChange(current, options()[1])).toEqual({ selection: sonnet });
    expect(modelChange(current, options()[2])).toEqual({ selection: pi });
  });

  it('does nothing for a disabled or already-selected model, even with different thinking', () => {
    expect(modelChange(current, options(true)[2])).toBeNull();
    expect(modelChange(current, options()[0])).toBeNull();
  });

  it('changes thinking including null while retaining all other concrete fields', () => {
    expect(thinkingChange(pi, null)).toEqual({ selection: { ...pi, thinking: null } });
    expect(thinkingChange(pi, 'high')).toEqual({ selection: { ...pi, thinking: 'high' } });
    expect(thinkingChange(pi, 'xhigh')).toBeNull();
    expect(thinkingChange({ ...pi, thinking: null }, null)).toBeNull();
  });

  it('changes only the route and ignores repeated picks', () => {
    expect(modeChange(current, 'api')).toEqual({ selection: { ...current, mode: 'api' } });
    expect(modeChange(current, 'plan')).toBeNull();
  });
});

describe('selection presentation', () => {
  const copy = { model: 'Model', thinking: 'Thinking', mode: 'Mode', default: 'Default' };

  it('uses the concrete model and thinking without override state', () => {
    expect(selectionChipParts(current)).toEqual({ main: 'opus-5', sub: 'high' });
    expect(selectionChipParts({ ...current, model: '', thinking: null })).toEqual({ main: '—', sub: null });
    expect(selectionRootRows({ ...current, thinking: null }, copy, { hasThinking: true, hasModes: true })).toEqual([
      { key: 'model', label: 'Model', value: current.model },
      { key: 'thinking', label: 'Thinking', value: 'Default' },
      { key: 'mode', label: 'Mode', value: 'plan' },
    ]);
  });

  it('omits unavailable drill-downs rather than adding follow or clear rows', () => {
    expect(selectionRootRows(current, copy, { hasThinking: false, hasModes: false }))
      .toEqual([{ key: 'model', label: 'Model', value: current.model }]);
  });
});

describe('independent environment choices', () => {
  const agents: ConfigAgentEntry[] = [{ name: 'main', description: 'Default environment' }, { name: 'research' }];
  const entries = buildAgentOptions(agents, { agentName: 'main' });

  it('has no engine constraint and exposes only environment metadata', () => {
    expect(entries).toEqual([
      { name: 'main', description: 'Default environment', active: true, disabled: false },
      { name: 'research', description: null, active: false, disabled: false },
    ]);
    expect(agentRowSub(entries[0])).toBe('Default environment');
    expect(agentRowSub(entries[1])).toBeNull();
    expect(agentChange(entries, 'main', 'research')).toEqual({ agentName: 'research' });
    expect(agentChange(entries, 'main', null)).toEqual({ agentName: null });
  });

  it('ignores repeated and unknown picks', () => {
    expect(agentChange(entries, 'main', 'main')).toBeNull();
    expect(agentChange(entries, null, null)).toBeNull();
    expect(agentChange(entries, 'main', 'missing')).toBeNull();
  });

  it('labels explicit and default environments without claiming an unknown default', () => {
    expect(agentChipParts(entries, 'research')).toEqual({ name: 'research', description: null, followingDefault: false });
    expect(agentChipParts(entries, null)).toEqual({ name: 'main', description: 'Default environment', followingDefault: true });
    expect(agentChipParts([], null)).toEqual({ name: null, description: null, followingDefault: true });
    expect(agentChipParts(entries, 'missing')).toEqual({ name: 'missing', description: null, followingDefault: false });
  });

  it('only shows a chooser for two or more environments', () => {
    expect(hasAgentChoice([])).toBe(false);
    expect(hasAgentChoice(agents.slice(0, 1))).toBe(false);
    expect(hasAgentChoice(agents)).toBe(true);
  });
});
