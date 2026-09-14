// input:  profile form state, ConfigProfileEntry and models.catalog fixtures
// output: validation, route transitions, choice lists, error copy, dirty and mutation-args regressions
// pos:    Unit tests for shared desktop/mobile profile form behavior
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { ConfigProfileEntry, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import {
  buildProfileCreateArgs,
  buildProfileDraft,
  emptyProfileForm,
  formStateFromEntry,
  isProfileFormDirty,
  isProfileFormValid,
  profileFieldChoices,
  profileFieldErrorCopy,
  transitionProfileBackend,
  transitionProfileProvider,
  usedOptionRows,
  validateProfileForm,
  withCurrentValue,
  type ProfileFormState,
} from './profiles-panel-vm';

const CATALOG: ModelCatalogSnapshot = {
  routes: [
    { endpoint: 'anthropic', backend: 'claude', provider: null, modes: ['plan', 'api'],
      models: ['claude-opus-5', 'claude-haiku-4-5'], source: 'builtin' },
    { endpoint: 'deepseek', backend: 'pi', provider: 'deepseek', modes: ['deepseek'],
      models: ['deepseek-v4-flash'], source: 'pi' },
    { endpoint: 'openai-codex', backend: 'pi', provider: 'openai-codex', modes: ['openai-codex'],
      models: [], source: 'gateway' },
  ],
  piPending: false,
};

function entry(over: Partial<ConfigProfileEntry> = {}): ConfigProfileEntry {
  return {
    name: 'plan',
    model: 'claude-opus-5',
    backend: 'claude',
    mode: 'plan',
    thinking: 'xhigh',
    provider: null,
    claudeBackend: null,
    extraOption: {},
    extraEnvKeys: [],
    fallbackCount: 0,
    ...over,
  };
}

function form(over: Partial<ProfileFormState> = {}): ProfileFormState {
  return { ...emptyProfileForm(), name: 'x', model: 'm', ...over };
}

describe('formStateFromEntry', () => {
  it('reads every editable field and defaults an undeclared backend to claude', () => {
    expect(formStateFromEntry(entry())).toEqual({
      name: 'plan',
      model: 'claude-opus-5',
      backend: 'claude',
      mode: 'plan',
      provider: '',
      thinking: 'xhigh',
      claudeBackend: '',
      extraOption: [],
    });
    expect(formStateFromEntry(entry({ backend: null })).backend).toBe('claude');
    expect(
      formStateFromEntry(entry({ extraOption: { '--thinking': 'xhigh' } })).extraOption,
    ).toEqual([{ key: '--thinking', value: 'xhigh' }]);
  });

  it('reads back as not dirty, so an untouched entry never offers a save', () => {
    for (const e of [entry(), entry({ backend: null }), entry({ extraOption: { '--a': '1', '--b': '2' } })]) {
      expect(isProfileFormDirty(formStateFromEntry(e), e)).toBe(false);
    }
  });

  it('reports a real edit as dirty', () => {
    const e = entry();
    expect(isProfileFormDirty({ ...formStateFromEntry(e), model: 'other' }, e)).toBe(true);
    expect(isProfileFormDirty({ ...formStateFromEntry(e), thinking: '' }, e)).toBe(true);
  });

  it('ignores blank option rows and their order', () => {
    const e = entry({ extraOption: { '--b': '2', '--a': '1' } });
    const state = formStateFromEntry(e);
    expect(isProfileFormDirty({ ...state, extraOption: [...state.extraOption].reverse() }, e)).toBe(false);
    expect(isProfileFormDirty({ ...state, extraOption: [...state.extraOption, { key: '', value: '' }] }, e))
      .toBe(false);
    expect(usedOptionRows([{ key: '', value: '' }, { key: '--a', value: '1' }])).toEqual([
      { key: '--a', value: '1' },
    ]);
  });
});

describe('transitionProfileBackend', () => {
  it('keeps a thinking level supported by the new backend', () => {
    const draft = form({ backend: 'claude', thinking: 'high' });

    expect(transitionProfileBackend(draft, 'pi')).toEqual({ ...draft, backend: 'pi' });
  });

  it('clears a thinking level unsupported by the new backend in either direction', () => {
    const claudeDraft = form({ backend: 'claude', thinking: 'max' });
    const piDraft = form({ backend: 'pi', thinking: 'off' });

    expect(transitionProfileBackend(claudeDraft, 'pi').thinking).toBe('');
    expect(transitionProfileBackend(piDraft, 'claude').thinking).toBe('');
  });
});

describe('profileFieldErrorCopy', () => {
  it('maps validation codes to their shared vocabulary copy', () => {
    const copy = {
      pfErrNameRequired: 'name copy',
      pfErrNameCharset: '',
      pfErrNameTaken: '',
      pfErrModelRequired: 'model copy',
      pfErrModeCharset: '',
      pfErrProviderRequired: 'provider copy',
      pfErrProviderCharset: '',
      pfErrThinkingLevel: '',
      pfErrOptionKeyPrefix: '',
      pfErrOptionKeyDuplicate: '',
      pfErrOptionValueRequired: '',
    };

    expect(profileFieldErrorCopy('model-required', copy)).toBe('model copy');
    expect(profileFieldErrorCopy('provider-required', copy)).toBe('provider copy');
    expect(profileFieldErrorCopy(undefined, copy)).toBeUndefined();
  });
});

describe('validateProfileForm', () => {
  const opts = { mode: 'create' as const, existingNames: ['plan', 'sol'] };

  it('accepts a minimal claude profile', () => {
    expect(isProfileFormValid(validateProfileForm(form(), opts))).toBe(true);
  });

  it('rejects an empty, unsafe or taken name', () => {
    expect(validateProfileForm(form({ name: '' }), opts).name).toBe('name-required');
    expect(validateProfileForm(form({ name: 'a b' }), opts).name).toBe('name-charset');
    expect(validateProfileForm(form({ name: '../etc' }), opts).name).toBe('name-charset');
    expect(validateProfileForm(form({ name: 'plan' }), opts).name).toBe('name-taken');
    // an update keeps its own name — the collision check is create-only
    expect(validateProfileForm(form({ name: 'plan' }), { mode: 'update', existingNames: ['plan'] }).name)
      .toBeUndefined();
  });

  it('requires a model', () => {
    expect(validateProfileForm(form({ model: '   ' }), opts).model).toBe('model-required');
  });

  it('requires a provider for pi and echoes the backend-specific thinking levels', () => {
    expect(validateProfileForm(form({ backend: 'pi' }), opts).provider).toBe('provider-required');
    expect(validateProfileForm(form({ backend: 'pi', provider: 'deepseek' }), opts).provider).toBeUndefined();
    // 'max' is claude-only; 'off' is pi-only
    expect(validateProfileForm(form({ backend: 'pi', provider: 'p', thinking: 'max' }), opts).thinking)
      .toBe('thinking-level');
    expect(validateProfileForm(form({ backend: 'claude', thinking: 'off' }), opts).thinking)
      .toBe('thinking-level');
    expect(validateProfileForm(form({ backend: 'claude', thinking: 'max' }), opts).thinking).toBeUndefined();
  });

  it('rejects a bad mode or provider charset', () => {
    expect(validateProfileForm(form({ mode: 'a/b' }), opts).mode).toBe('mode-charset');
    expect(validateProfileForm(form({ provider: 'a b' }), opts).provider).toBe('provider-charset');
  });

  it('rejects flags without --, duplicates and empty values', () => {
    expect(validateProfileForm(form({ extraOption: [{ key: 'thinking', value: 'x' }] }), opts).extraOption)
      .toBe('option-key-prefix');
    expect(
      validateProfileForm(
        form({ extraOption: [{ key: '--a', value: '1' }, { key: '--a', value: '2' }] }),
        opts,
      ).extraOption,
    ).toBe('option-key-duplicate');
    expect(validateProfileForm(form({ extraOption: [{ key: '--a', value: '' }] }), opts).extraOption)
      .toBe('option-value-required');
  });
});

describe('buildProfileDraft', () => {
  it('drops the fields the form leaves blank rather than writing them empty', () => {
    expect(buildProfileDraft(form())).toEqual({ model: 'm', backend: 'claude' });
  });

  it('trims and carries every declared field', () => {
    expect(
      buildProfileCreateArgs(
        form({
          name: '  sol  ',
          model: ' gpt-5 ',
          backend: 'pi',
          mode: 'openai',
          provider: 'openai',
          thinking: 'xhigh',
          extraOption: [{ key: ' --thinking ', value: ' xhigh ' }, { key: '', value: '' }],
        }),
      ),
    ).toEqual({
      name: 'sol',
      model: 'gpt-5',
      backend: 'pi',
      mode: 'openai',
      provider: 'openai',
      thinking: 'xhigh',
      extraOption: { '--thinking': 'xhigh' },
    });
  });

  it('sends claudeBackend only when it is declared', () => {
    expect(buildProfileDraft(form({ claudeBackend: '' })).claudeBackend).toBeUndefined();
    expect(buildProfileDraft(form({ claudeBackend: 'tui' })).claudeBackend).toBe('tui');
  });
});

describe('catalog-backed choices', () => {
  it('offers the routes of the draft backend, and the endpoint decides model and mode', () => {
    const claude = profileFieldChoices(CATALOG, form({ backend: 'claude' }));
    expect(claude.provider).toEqual(['anthropic']);
    expect(claude.model).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
    expect(claude.mode).toEqual(['plan', 'api']);

    const pi = profileFieldChoices(CATALOG, form({ backend: 'pi', provider: 'deepseek' }));
    expect(pi.provider).toEqual(['deepseek', 'openai-codex']);
    expect(pi.model).toEqual(['deepseek-v4-flash']);
  });

  it('reports an empty list — not the current value — when the catalog knows nothing', () => {
    // An empty list is what makes the editor fall back to free text, so it must stay empty.
    expect(profileFieldChoices(null, form({ model: 'private-model' })).model).toEqual([]);
    expect(profileFieldChoices(CATALOG, form({ backend: 'pi', provider: '' })).model).toEqual([]);
    expect(profileFieldChoices(CATALOG, form({ backend: 'pi', provider: 'openai-codex' })).route?.source)
      .toBe('gateway');
    expect(withCurrentValue([], 'private-model')).toEqual(['private-model']);
    expect(withCurrentValue(['a'], 'a')).toEqual(['a']);
    expect(withCurrentValue(['a'], '')).toEqual(['a']);
  });
});

describe('transitionProfileProvider', () => {
  it('re-points mode and model at the endpoint the provider selects', () => {
    const next = transitionProfileProvider(
      form({ backend: 'pi', provider: 'openai-codex', mode: 'openai-codex', model: 'gpt-6' }),
      'deepseek',
      CATALOG,
    );
    expect(next).toMatchObject({ provider: 'deepseek', mode: 'deepseek', model: '' });
  });

  it('keeps a model the new endpoint can serve, and leaves an unknown endpoint alone', () => {
    expect(transitionProfileProvider(
      form({ backend: 'pi', model: 'deepseek-v4-flash', mode: 'deepseek' }), 'deepseek', CATALOG,
    )).toMatchObject({ model: 'deepseek-v4-flash', mode: 'deepseek' });
    // A route with no known models cannot judge one: the field is left as typed.
    expect(transitionProfileProvider(
      form({ backend: 'pi', model: 'gpt-6', mode: 'nope' }), 'openai-codex', CATALOG,
    )).toMatchObject({ model: 'gpt-6', mode: 'openai-codex' });
    expect(transitionProfileProvider(
      form({ backend: 'pi', model: 'whatever', mode: 'whatever' }), 'self-hosted', CATALOG,
    )).toMatchObject({ model: 'whatever', mode: 'whatever' });
  });
});

describe('transitionProfileBackend with a catalog', () => {
  it('drops a provider that belongs to the other backend and re-points the route', () => {
    expect(transitionProfileBackend(
      form({ backend: 'pi', provider: 'deepseek', mode: 'deepseek', model: 'deepseek-v4-flash' }),
      'claude',
      CATALOG,
    )).toMatchObject({ backend: 'claude', provider: '', mode: 'plan', model: '' });
  });

  it('without a catalog behaves exactly as before — nothing but the thinking cleanup', () => {
    expect(transitionProfileBackend(
      form({ backend: 'pi', provider: 'deepseek', mode: 'deepseek', thinking: 'off' }), 'claude',
    )).toMatchObject({ backend: 'claude', provider: 'deepseek', mode: 'deepseek', thinking: '' });
  });
});
