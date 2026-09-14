import { describe, it, expect } from 'vitest';
import type { ConfigProfileEntry, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import {
  buildModelOptions, buildProfileOptions, buildThinkingOptions, clearAllChange, effectiveSelection,
  groupModelOptions, modelChange, profileChange, profileForModel, selectionRootRows, thinkingChange,
  visibleModelOptions, visibleProfileOptions,
} from './selection-menu';

function profile(over: Partial<ConfigProfileEntry> & Pick<ConfigProfileEntry, 'name'>): ConfigProfileEntry {
  return {
    model: null, backend: null, mode: null, thinking: null,
    provider: null, claudeBackend: null, extraOption: {}, extraEnvKeys: [], fallbackCount: 0,
    ...over,
  };
}

const profiles: ConfigProfileEntry[] = [
  profile({ name: 'opus', model: 'claude-opus-5', backend: 'claude', mode: 'plan', thinking: 'xhigh' }),
  profile({ name: 'sonnet', model: 'claude-sonnet-5', backend: 'claude', mode: 'plan' }),
  profile({ name: 'ds', model: 'deepseek-v4-flash', backend: 'pi', mode: 'deepseek', provider: 'deepseek' }),
  profile({ name: 'codex', model: 'gpt-6-astra', backend: 'pi', mode: 'openai-codex', provider: 'openai-codex', thinking: 'high' }),
];

const catalog: ModelCatalogSnapshot = {
  routes: [
    {
      endpoint: 'anthropic', backend: 'claude', provider: null, modes: ['plan', 'api'],
      models: ['claude-opus-5', 'claude-sonnet-5'], source: 'builtin', modelThinking: {},
    },
    {
      endpoint: 'deepseek', backend: 'pi', provider: 'deepseek', modes: ['deepseek'],
      models: ['deepseek-v4-flash'], source: 'pi', modelThinking: {},
    },
    {
      endpoint: 'openai-codex', backend: 'pi', provider: 'openai-codex', modes: ['openai-codex'],
      models: ['gpt-6-astra', 'gpt-5.6-sol'], source: 'pi', modelThinking: {},
    },
  ],
  thinkingLevels: {
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  piPending: false,
};

describe('effectiveSelection', () => {
  it('reports the profile as-is when nothing was overridden', () => {
    expect(effectiveSelection(profiles, 'opus', null)).toEqual({
      profileName: 'opus', backend: 'claude', model: 'claude-opus-5', provider: null,
      thinking: 'xhigh', mode: 'plan', modelOverridden: false, thinkingOverridden: false,
      modeOverridden: false,
    });
  });

  it('lets the session choice win, and says which half it is', () => {
    const selection = effectiveSelection(profiles, 'opus', { model: 'claude-haiku-4-5' });
    expect(selection.model).toBe('claude-haiku-4-5');
    expect(selection.modelOverridden).toBe(true);
    expect(selection.thinking).toBe('xhigh');
    expect(selection.thinkingOverridden).toBe(false);
  });

  it('carries an overridden pi provider', () => {
    const selection = effectiveSelection(profiles, 'ds', { provider: 'zai', model: 'glm-5' });
    expect(selection).toMatchObject({ backend: 'pi', provider: 'zai', model: 'glm-5' });
  });

  it('falls back to claude for an unknown profile rather than throwing', () => {
    expect(effectiveSelection(profiles, 'ghost', null)).toMatchObject({ backend: 'claude', model: null });
  });
});

describe('buildModelOptions', () => {
  const claudeNow = effectiveSelection(profiles, 'opus', null);
  const piNow = effectiveSelection(profiles, 'ds', null);

  it('marks the running model active — and only that one', () => {
    const options = buildModelOptions(catalog, profiles, claudeNow, { hasHistory: false, defaultProfile: 'opus' });
    expect(options.filter((option) => option.active).map((option) => option.id)).toEqual(['claude-opus-5']);
  });

  it('matches a pi model on provider AND id, not id alone', () => {
    const sameIdOtherProvider: ModelCatalogSnapshot = {
      ...catalog,
      routes: [{
        endpoint: 'zai', backend: 'pi', provider: 'zai', modes: ['zai'],
        models: ['deepseek-v4-flash'], source: 'pi', modelThinking: {},
      }],
    };
    const options = buildModelOptions(sameIdOtherProvider, profiles, piNow, { hasHistory: false, defaultProfile: 'ds' });
    expect(options[0].active).toBe(false);
  });

  it('a same-backend model needs no profile move — the server re-bases a provider change', () => {
    const options = buildModelOptions(catalog, profiles, piNow, { hasHistory: false, defaultProfile: 'ds' });
    const sol = options.find((option) => option.id === 'gpt-5.6-sol')!;
    expect(sol.disabled).toBe(false);
    expect(sol.profileName).toBeNull();
  });

  it('a cross-backend model names the profile it would land on', () => {
    const options = buildModelOptions(catalog, profiles, claudeNow, { hasHistory: false, defaultProfile: 'opus' });
    expect(options.find((option) => option.id === 'deepseek-v4-flash')!.profileName).toBe('ds');
    expect(options.find((option) => option.id === 'gpt-6-astra')!.profileName).toBe('codex');
  });

  it('a live conversation may not cross backends', () => {
    const options = buildModelOptions(catalog, profiles, claudeNow, { hasHistory: true, defaultProfile: 'opus' });
    expect(options.find((option) => option.id === 'claude-sonnet-5')!.disabled).toBe(false);
    const pi = options.find((option) => option.id === 'deepseek-v4-flash')!;
    expect(pi).toMatchObject({ disabled: true, disabledReason: 'cross-backend' });
  });

  it('a backend with no profile at all is unpickable, with a reason of its own', () => {
    const claudeOnly = profiles.filter((entry) => (entry.backend ?? 'claude') === 'claude');
    const options = buildModelOptions(catalog, claudeOnly, claudeNow, { hasHistory: false, defaultProfile: 'opus' });
    expect(options.find((option) => option.id === 'deepseek-v4-flash')).toMatchObject({
      disabled: true, disabledReason: 'no-profile', profileName: null,
    });
  });

  it('is empty, not broken, before the catalog arrives', () => {
    expect(buildModelOptions(null, profiles, claudeNow, { hasHistory: false, defaultProfile: null })).toEqual([]);
  });
});

// What the rule above decides is pickable, this decides is DRAWN: a row nobody can click is not
// drawn at all, and the count that replaces it carries the reason.
describe('visibleModelOptions', () => {
  const claudeNow = effectiveSelection(profiles, 'opus', null);

  it('holds back the other backend in a live conversation, and says which one', () => {
    const visible = visibleModelOptions(
      buildModelOptions(catalog, profiles, claudeNow, { hasHistory: true, defaultProfile: 'opus' }),
    );
    expect(visible.options.map((option) => option.id)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(visible).toMatchObject({ hiddenCrossBackend: 3, hiddenBackend: 'pi', hiddenNoProfile: 0 });
  });

  it('holds nothing back for a draft — it may still choose its backend', () => {
    const visible = visibleModelOptions(
      buildModelOptions(catalog, profiles, claudeNow, { hasHistory: false, defaultProfile: 'opus' }),
    );
    expect(visible.options).toHaveLength(5);
    expect(visible).toMatchObject({ hiddenCrossBackend: 0, hiddenBackend: null, hiddenNoProfile: 0 });
  });

  it('counts a backend this host cannot run at all separately — a new conversation would not help', () => {
    const claudeOnly = profiles.filter((entry) => (entry.backend ?? 'claude') === 'claude');
    const visible = visibleModelOptions(
      buildModelOptions(catalog, claudeOnly, claudeNow, { hasHistory: false, defaultProfile: 'opus' }),
    );
    expect(visible.options.map((option) => option.id)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(visible).toMatchObject({ hiddenCrossBackend: 0, hiddenNoProfile: 3 });
  });
});

describe('visibleProfileOptions', () => {
  it('drops the profiles a live conversation cannot move to, and counts them', () => {
    const options = buildProfileOptions(profiles, 'opus', { currentBackend: 'claude', hasHistory: true });
    expect(visibleProfileOptions(options)).toMatchObject({ hidden: 2, hiddenBackend: 'pi' });
    expect(visibleProfileOptions(options).options.map((option) => option.name)).toEqual(['opus', 'sonnet']);
  });

  it('leaves the whole list of a draft alone', () => {
    const options = buildProfileOptions(profiles, 'opus', { currentBackend: 'claude', hasHistory: false });
    expect(visibleProfileOptions(options)).toMatchObject({ hidden: 0, hiddenBackend: null });
  });
});

describe('selectionRootRows', () => {
  const copy = { model: 'model', thinking: 'thinking', mode: 'route' };

  it('shows the value in force, and whether the session chose it', () => {
    const current = effectiveSelection(profiles, 'opus', { model: 'claude-sonnet-5' });
    expect(selectionRootRows(current, copy, { hasThinking: true, hasModes: true })).toEqual([
      { key: 'model', label: 'model', value: 'claude-sonnet-5', overridden: true },
      { key: 'thinking', label: 'thinking', value: 'xhigh', overridden: false },
      { key: 'mode', label: 'route', value: 'plan', overridden: false },
    ]);
  });

  it('has no row for a choice the session cannot make, and a dash for one nothing declares', () => {
    const current = effectiveSelection(profiles, 'sonnet', null);
    const rows = selectionRootRows(current, copy, { hasThinking: true, hasModes: false });
    expect(rows.map((row) => row.key)).toEqual(['model', 'thinking']);
    expect(rows[1].value).toBe('—');
  });
});

describe('clearAllChange', () => {
  it('states an empty selection, which is how the server reads "follow the profile again"', () => {
    expect(clearAllChange(effectiveSelection(profiles, 'opus', { thinking: 'low' })))
      .toEqual({ selection: {} });
  });

  it('is nothing to do when the profile is already running as declared', () => {
    expect(clearAllChange(effectiveSelection(profiles, 'opus', null))).toBeNull();
  });
});

describe('groupModelOptions', () => {
  it('groups by provider and puts the running backend first', () => {
    const piNow = effectiveSelection(profiles, 'ds', null);
    const groups = groupModelOptions(
      buildModelOptions(catalog, profiles, piNow, { hasHistory: false, defaultProfile: 'ds' }),
      'pi',
    );
    expect(groups.map((group) => group.group)).toEqual(['deepseek', 'openai-codex', 'claude']);
    expect(groups[1].options.map((option) => option.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
  });
});

describe('buildThinkingOptions', () => {
  it('offers the levels of the backend the session runs on', () => {
    const claudeNow = effectiveSelection(profiles, 'opus', null);
    expect(buildThinkingOptions(catalog, claudeNow).map((option) => option.level))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const piNow = effectiveSelection(profiles, 'codex', null);
    expect(buildThinkingOptions(catalog, piNow).map((option) => option.level))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('marks the running level', () => {
    const piNow = effectiveSelection(profiles, 'codex', null);
    expect(buildThinkingOptions(catalog, piNow).filter((option) => option.active).map((o) => o.level))
      .toEqual(['high']);
  });
});

describe('profileForModel', () => {
  it('prefers the profile that already uses that provider', () => {
    expect(profileForModel(profiles, { backend: 'pi', provider: 'openai-codex', id: 'x' }, 'ds')).toBe('codex');
  });

  it('falls back to the default profile of that backend, then to the first one', () => {
    expect(profileForModel(profiles, { backend: 'pi', provider: 'zai', id: 'glm-5' }, 'codex')).toBe('codex');
    expect(profileForModel(profiles, { backend: 'pi', provider: 'zai', id: 'glm-5' }, 'opus')).toBe('ds');
  });

  it('returns null when the host runs no profile on that backend', () => {
    const claudeOnly = profiles.filter((entry) => (entry.backend ?? 'claude') === 'claude');
    expect(profileForModel(claudeOnly, { backend: 'pi', provider: 'deepseek', id: 'x' }, 'opus')).toBeNull();
  });
});

describe('the change a pick produces', () => {
  const now = effectiveSelection(profiles, 'opus', { model: 'claude-haiku-4-5', thinking: 'low' });
  const override = { model: 'claude-haiku-4-5', thinking: 'low' };
  const options = buildModelOptions(catalog, profiles, now, { hasHistory: false, defaultProfile: 'opus' });
  const option = (id: string) => options.find((entry) => entry.id === id)!;

  it('a same-backend model keeps the profile and the rest of the selection', () => {
    expect(modelChange(now, override, option('claude-sonnet-5'))).toEqual({
      selection: { model: 'claude-sonnet-5', thinking: 'low' },
    });
  });

  it('a cross-backend model names its profile and starts the selection over', () => {
    expect(modelChange(now, override, option('deepseek-v4-flash'))).toEqual({
      profileName: 'ds',
      selection: { model: 'deepseek-v4-flash', provider: 'deepseek' },
    });
  });

  it('taking the model back leaves the chosen level alone', () => {
    expect(modelChange(now, override, null)).toEqual({ selection: { thinking: 'low' } });
  });

  it('does nothing for a row that is already running, disabled, or not overridden', () => {
    const plain = effectiveSelection(profiles, 'opus', null);
    expect(modelChange(plain, null, null)).toBeNull();
    const plainOptions = buildModelOptions(catalog, profiles, plain, { hasHistory: true, defaultProfile: 'opus' });
    expect(modelChange(plain, null, plainOptions.find((entry) => entry.id === 'claude-opus-5')!)).toBeNull();
    expect(modelChange(plain, null, plainOptions.find((entry) => entry.id === 'gpt-6-astra')!)).toBeNull();
  });

  it('a thinking level rides on top of the model already chosen', () => {
    expect(thinkingChange(now, override, 'high')).toEqual({
      selection: { model: 'claude-haiku-4-5', thinking: 'high' },
    });
    expect(thinkingChange(now, override, null)).toEqual({ selection: { model: 'claude-haiku-4-5' } });
    expect(thinkingChange(now, override, 'low')).toBeNull();
  });

  it('a profile row carries no selection — the server drops the old one', () => {
    const profileOptions = buildProfileOptions(profiles, 'opus', { currentBackend: 'claude', hasHistory: false });
    expect(profileChange(profileOptions, now, 'sonnet')).toEqual({ profileName: 'sonnet' });
    const live = buildProfileOptions(profiles, 'opus', { currentBackend: 'claude', hasHistory: true });
    expect(profileChange(live, now, 'ds')).toBeNull();
  });

  it('the profile already running is still a way to say "run it as declared"', () => {
    const profileOptions = buildProfileOptions(profiles, 'opus', { currentBackend: 'claude', hasHistory: false });
    // `now` runs opus with a model and a level on top: the ticked row is where a user takes those
    // back, and it means the same thing picking any other profile means.
    expect(profileChange(profileOptions, now, 'opus')).toEqual({ profileName: 'opus' });
    // Nothing on top of it — the row has nothing left to do.
    const plain = effectiveSelection(profiles, 'opus', null);
    expect(profileChange(profileOptions, plain, 'opus')).toBeNull();
  });
});
