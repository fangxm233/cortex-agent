import { describe, expect, it } from 'vitest';
import type { AuthStatusSnapshot, ConnectionView } from '@cortex-agent/ui-contract';
import {
  buildConnectionArgs,
  buildConnectionRows,
  emptyConnectionForm,
  formStateFromConnection,
  isConnectionFormValid,
  overridableProviders,
  parseModelIds,
  validateConnectionForm,
  type ConnectionFormState,
} from './connections-vm';

const L = { connOfficialApi: 'Anthropic API', connAnthropicModels: 'Anthropic models' };

function view(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: 'relay', backend: 'claude', provider: null, kind: 'key', label: 'relay', baseUrl: 'https://relay.example',
    authStyle: 'bearer', billing: 'metered', authenticated: true, keyHint: 'sk-…abcd', models: null, ...over,
  };
}

const CUSTOM = view({
  id: 'vllm', backend: 'pi', provider: 'vllm', kind: 'custom', api: 'openai-completions',
  baseUrl: 'http://box:8000/v1', authStyle: undefined, keyHint: null, models: ['m1', 'm2'],
});
const OVERRIDE = view({ id: 'openai', backend: 'pi', provider: 'openai', kind: 'override', authStyle: undefined, baseUrl: 'https://proxy/v1' });
const SUBSCRIPTION = view({ id: 'subscription', kind: 'subscription', baseUrl: null, keyHint: null });

function form(over: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return { ...emptyConnectionForm('claude'), name: 'relay', key: 'sk-new', ...over };
}

describe('buildConnectionRows', () => {
  it('lists stored connections only, each with its key hint and a one-line summary', () => {
    const rows = buildConnectionRows([SUBSCRIPTION, view(), CUSTOM, OVERRIDE], L);
    expect(rows.map((row) => row.key)).toEqual(['claude:relay', 'pi:vllm', 'pi:openai']);
    expect(rows.map((row) => row.kind)).toEqual(['claude', 'pi-custom', 'pi-override']);
    expect(rows[0].meta).toBe('https://relay.example  ·  Anthropic models');
    expect(rows[0].keyHint).toBe('sk-…abcd');
    expect(rows[1].meta).toBe('openai-completions  ·  http://box:8000/v1  ·  m1, m2');
    expect(rows[2].meta).toBe('https://proxy/v1');
  });

  it('marks the api connection as the Accounts API-key slot and names the official endpoint', () => {
    const [row] = buildConnectionRows([view({ id: 'api', baseUrl: null, models: ['claude-x'] })], L);
    expect(row.apiKeySlot).toBe(true);
    expect(row.meta).toBe('Anthropic API  ·  claude-x');
  });
});

describe('overridableProviders', () => {
  it('offers PI providers that have no stored connection yet', () => {
    const account = (backend: 'claude' | 'pi', provider: string) => ({ backend, provider }) as AuthStatusSnapshot['accounts'][number];
    const status = { accounts: [account('claude', 'anthropic'), account('pi', 'openai'), account('pi', 'google'), account('pi', 'vllm')] } as AuthStatusSnapshot;
    expect(overridableProviders(status, [CUSTOM, OVERRIDE])).toEqual(['google']);
    expect(overridableProviders(undefined, [])).toEqual([]);
  });
});

describe('formStateFromConnection', () => {
  it('opens every kind with its stored fields and an empty key', () => {
    expect(formStateFromConnection(view())).toMatchObject({
      kind: 'claude', name: 'relay', baseUrl: 'https://relay.example', authStyle: 'bearer', key: '', models: '',
    });
    expect(formStateFromConnection(CUSTOM)).toMatchObject({ kind: 'pi-custom', name: 'vllm', api: 'openai-completions', models: 'm1\nm2' });
    expect(formStateFromConnection(OVERRIDE)).toMatchObject({ kind: 'pi-override', name: 'openai', baseUrl: 'https://proxy/v1' });
  });
});

describe('parseModelIds', () => {
  it('accepts newline and comma separated ids and drops blanks', () => {
    expect(parseModelIds(' a\n b , c \n\n')).toEqual(['a', 'b', 'c']);
  });
});

describe('validateConnectionForm', () => {
  const existing = [{ backend: 'claude' as const, id: 'relay' }, { backend: 'pi' as const, id: 'vllm' }];
  const create = { mode: 'create' as const, existing };
  const update = { mode: 'update' as const, existing };

  it('accepts a Claude connection with only a name and a key', () => {
    expect(validateConnectionForm(form({ name: 'other' }), create)).toEqual({});
  });

  it('checks the name: required, charset, reserved, and free on its own backend when creating', () => {
    expect(validateConnectionForm(form({ name: ' ' }), create).name).toBe('name-required');
    expect(validateConnectionForm(form({ name: 'a b' }), create).name).toBe('name-charset');
    expect(validateConnectionForm(form({ name: 'subscription' }), create).name).toBe('name-reserved');
    expect(validateConnectionForm(form(), create).name).toBe('name-taken');
    expect(validateConnectionForm(form(), update).name).toBeUndefined();
    expect(validateConnectionForm(form({ kind: 'pi-override', name: 'relay', baseUrl: 'https://x' }), create).name).toBeUndefined();
  });

  it('requires a key on a new Claude connection only', () => {
    expect(validateConnectionForm(form({ name: 'other', key: '' }), create).key).toBe('key-required');
    expect(validateConnectionForm(form({ key: '' }), update).key).toBeUndefined();
    expect(validateConnectionForm(form({ kind: 'pi-override', name: 'openai', key: '', baseUrl: 'https://x' }), create)).toEqual({});
  });

  it('lets a Claude endpoint stay empty but requires one for PI, always http(s)', () => {
    expect(validateConnectionForm(form({ baseUrl: 'ftp://x' }), update).baseUrl).toBe('url-scheme');
    expect(validateConnectionForm(form({ kind: 'pi-override', name: 'openai' }), create).baseUrl).toBe('url-required');
  });

  it('requires models on a custom provider and unique ids everywhere', () => {
    const custom = form({ kind: 'pi-custom', name: 'new', baseUrl: 'http://box' });
    expect(validateConnectionForm(custom, create).models).toBe('models-required');
    expect(validateConnectionForm({ ...custom, models: 'a\na' }, create).models).toBe('model-id-duplicate');
    expect(validateConnectionForm(form({ models: 'a, a' }), update).models).toBe('model-id-duplicate');
    expect(isConnectionFormValid(validateConnectionForm({ ...custom, models: 'a' }, create))).toBe(true);
  });
});

describe('buildConnectionArgs', () => {
  it('sends an empty Claude endpoint and model list as the Anthropic defaults', () => {
    expect(buildConnectionArgs(form({ name: ' relay ', key: ' sk-new ' }), 'create')).toEqual({
      kind: 'claude', id: 'relay', baseUrl: '', authStyle: 'x-api-key', models: [], key: 'sk-new', create: true,
    });
  });

  it('omits an empty key so an edit keeps the stored one', () => {
    const args = buildConnectionArgs(form({ key: '', baseUrl: 'https://r', models: 'a\nb' }), 'update');
    expect(args).toEqual({ kind: 'claude', id: 'relay', baseUrl: 'https://r', authStyle: 'x-api-key', models: ['a', 'b'] });
  });

  it('builds the PI kinds from the same form', () => {
    expect(buildConnectionArgs(form({ kind: 'pi-override', name: 'openai', baseUrl: 'https://p', key: '' }), 'update'))
      .toEqual({ kind: 'pi-override', provider: 'openai', baseUrl: 'https://p' });
    expect(buildConnectionArgs(form({ kind: 'pi-custom', name: 'vllm', baseUrl: 'http://b', api: 'openai-responses', models: 'm1', key: 'k' }), 'create'))
      .toEqual({ kind: 'pi-custom', provider: 'vllm', baseUrl: 'http://b', api: 'openai-responses', models: ['m1'], key: 'k', create: true });
  });
});
