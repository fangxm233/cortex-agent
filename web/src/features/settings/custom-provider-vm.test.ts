// input:  custom provider form state and CustomProviderView fixtures
// output: validation, round-trip and mutation-args regressions
// pos:    Unit tests for the custom provider view model
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { CustomProviderView } from '@cortex-agent/ui-contract';
import {
  buildCustomProviderArgs,
  emptyCustomProviderForm,
  formStateFromCustomProvider,
  isCustomProviderFormValid,
  parseModelIds,
  validateCustomProviderForm,
  type CustomProviderFormState,
} from './custom-provider-vm';

function view(over: Partial<CustomProviderView> = {}): CustomProviderView {
  return {
    name: 'my-vllm',
    api: 'anthropic-messages',
    models: [{ id: 'Model-27B' }, { id: 'Model-8B' }],
    upstreamUrl: 'http://127.0.0.1:8100',
    hasApiKey: true,
    routed: true,
    ...over,
  };
}

function form(over: Partial<CustomProviderFormState> = {}): CustomProviderFormState {
  return {
    ...emptyCustomProviderForm(),
    name: 'my-vllm',
    upstreamUrl: 'http://127.0.0.1:8100',
    models: 'Model-27B',
    ...over,
  };
}

describe('formStateFromCustomProvider', () => {
  it('lists model ids one per line and opens the key field empty', () => {
    const state = formStateFromCustomProvider(view());
    expect(state.models).toBe('Model-27B\nModel-8B');
    expect(state.apiKey).toBe('');
    expect(state.upstreamUrl).toBe('http://127.0.0.1:8100');
  });

  it('tolerates a definition with no gateway route', () => {
    expect(formStateFromCustomProvider(view({ upstreamUrl: null, routed: false })).upstreamUrl).toBe('');
  });
});

describe('parseModelIds', () => {
  it('accepts newline and comma separated ids and drops blanks', () => {
    expect(parseModelIds(' a\n b , c \n\n')).toEqual(['a', 'b', 'c']);
    expect(parseModelIds('   ')).toEqual([]);
  });
});

describe('validateCustomProviderForm', () => {
  const options = { mode: 'create' as const, existingNames: ['taken'] };

  it('accepts a well-formed draft', () => {
    expect(isCustomProviderFormValid(validateCustomProviderForm(form(), options))).toBe(true);
  });

  it('refuses a missing or non-conforming name', () => {
    expect(validateCustomProviderForm(form({ name: '' }), options).name).toBe('name-required');
    expect(validateCustomProviderForm(form({ name: 'my vllm' }), options).name).toBe('name-charset');
    expect(validateCustomProviderForm(form({ name: 'taken' }), options).name).toBe('name-taken');
  });

  it('allows an edit to keep its own name', () => {
    const errors = validateCustomProviderForm(form({ name: 'taken' }), { mode: 'update', existingNames: ['taken'] });
    expect(errors.name).toBeUndefined();
  });

  it('requires an http upstream', () => {
    expect(validateCustomProviderForm(form({ upstreamUrl: '' }), options).upstreamUrl).toBe('upstream-required');
    expect(validateCustomProviderForm(form({ upstreamUrl: 'ftp://box' }), options).upstreamUrl).toBe('upstream-scheme');
  });

  it('requires at least one unique model id', () => {
    expect(validateCustomProviderForm(form({ models: '' }), options).models).toBe('models-required');
    expect(validateCustomProviderForm(form({ models: 'a\na' }), options).models).toBe('model-id-duplicate');
  });
});

describe('buildCustomProviderArgs', () => {
  it('trims fields and expands the model list', () => {
    expect(buildCustomProviderArgs(form({ name: ' my-vllm ', models: 'a, b' }))).toEqual({
      name: 'my-vllm',
      api: 'anthropic-messages',
      upstreamUrl: 'http://127.0.0.1:8100',
      models: [{ id: 'a' }, { id: 'b' }],
    });
  });

  it('omits an empty key so the stored upstream secret survives an edit', () => {
    expect('apiKey' in buildCustomProviderArgs(form({ apiKey: '   ' }))).toBe(false);
    expect(buildCustomProviderArgs(form({ apiKey: ' k ' })).apiKey).toBe('k');
  });
});
