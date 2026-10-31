import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionView } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  saves: [] as unknown[],
  removals: [] as unknown[],
  connections: [] as unknown[],
  status: { accounts: [] as unknown[] },
}));

const KEY = 'sk-ant-sentinel-key';
const CUSTOM: ConnectionView = {
  id: 'my-vllm', backend: 'pi', provider: 'my-vllm', kind: 'custom', label: 'my-vllm', api: 'anthropic-messages',
  baseUrl: 'http://127.0.0.1:8100', billing: 'metered', authenticated: true, keyHint: 'sen…-key', models: ['Model-27B'],
};
const API: ConnectionView = {
  id: 'api', backend: 'claude', provider: null, kind: 'key', label: 'api', baseUrl: null, authStyle: 'x-api-key',
  billing: 'metered', authenticated: true, keyHint: 'sk-…-key', models: null,
};

vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  Select: ({ options, value, ...props }: any) => (
    <div data-select-control data-select-value={String(value)} {...props}>
      {options.map((option: any) => <span key={String(option.value)}>{option.label}</span>)}
    </div>
  ),
  useToast: () => ({ toast: () => {} }),
}));

vi.mock('@/lib/trpc', () => {
  const query = (kind: string) => ({
    queryOptions: () => ({ __kind: kind }),
    queryFilter: () => ({ __kind: kind }),
  });
  const mutation = (kind: string) => ({ mutationOptions: (options: object) => ({ __kind: kind, ...options }) });
  return { useTRPC: () => ({
    auth: { status: query('auth.status') },
    models: { catalog: query('models.catalog') },
    connections: { list: query('connections.list'), upsert: mutation('connections.upsert'), remove: mutation('connections.remove') },
  }) };
});

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => ({
    data: options.__kind === 'connections.list' ? harness.connections : harness.status,
    isLoading: false, isError: false, error: null,
  }),
  useMutation: (options: any) => ({
    mutate: (variables: unknown) => {
      if (options.__kind === 'connections.upsert') harness.saves.push(variables);
      else harness.removals.push(variables);
      options.onSuccess?.({}, variables);
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

import { ConnectionsCard } from './ConnectionsCard';

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><ConnectionsCard /></LangProvider>); });
  return renderer;
}

function click(renderer: ReactTestRenderer, action: string, index = 0): void {
  const buttons = renderer.root.findAll(node => node.props['data-conn-action'] === action && typeof node.type === 'string');
  const button = buttons[index];
  act(() => { button.props.onClick(); });
}

function field(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findAll(node => node.props['data-conn-field'] === name)[0];
}

function type(renderer: ReactTestRenderer, name: string, value: string): void {
  const control = field(renderer, name);
  act(() => {
    if (control.props.onValueChange) control.props.onValueChange(value);
    else control.props.onChange({ target: { value } });
  });
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

beforeEach(() => {
  harness.saves = [];
  harness.removals = [];
  harness.connections = [API, CUSTOM];
  harness.status = { accounts: [{ backend: 'pi', provider: 'openai' }] };
});

describe('desktop connections', () => {
  it('lists every stored connection with its key hint and marks the API-key slot', () => {
    const renderer = mount();
    const rows = renderer.root.findAll(node => typeof node.props['data-connection'] === 'string' && typeof node.type !== 'string');
    expect(rows.map(row => row.props['data-connection'])).toEqual(['claude:api', 'pi:my-vllm']);
    expect(renderer.root.findAll(node => node.props['data-conn-api-key-slot'] === '' && typeof node.type !== 'string')).toHaveLength(1);
    expect(text(renderer)).toContain('sk-…-key');
    expect(text(renderer)).not.toContain(KEY);
  });

  it('creates a Claude connection by default, with its key and the Anthropic defaults', () => {
    const renderer = mount();
    click(renderer, 'new');
    expect(field(renderer, 'models')).toBeDefined();
    expect(field(renderer, 'api')).toBeUndefined();
    type(renderer, 'name', 'relay');
    type(renderer, 'url', 'https://relay.example');
    type(renderer, 'key', KEY);
    click(renderer, 'save');

    expect(harness.saves).toEqual([{
      kind: 'claude', id: 'relay', baseUrl: 'https://relay.example', authStyle: 'x-api-key', models: [], key: KEY, create: true,
    }]);
  });

  it('switches the form to a custom PI provider and sends its definition', () => {
    const renderer = mount();
    click(renderer, 'new');
    type(renderer, 'kind', 'pi-custom');
    expect(field(renderer, 'auth')).toBeUndefined();
    type(renderer, 'name', 'my-proxy');
    type(renderer, 'api', 'openai-completions');
    type(renderer, 'url', 'https://proxy.example.com/v1');
    type(renderer, 'models', 'small\nlarge');
    click(renderer, 'save');

    expect(harness.saves).toEqual([{
      kind: 'pi-custom', provider: 'my-proxy', api: 'openai-completions', baseUrl: 'https://proxy.example.com/v1',
      models: ['small', 'large'], create: true,
    }]);
  });

  it('offers only PI providers without a connection for a new override', () => {
    const renderer = mount();
    click(renderer, 'new');
    type(renderer, 'kind', 'pi-override');
    expect(field(renderer, 'name').props.options).toEqual([{ value: 'openai', label: 'openai' }]);
    expect(field(renderer, 'models')).toBeUndefined();
    type(renderer, 'name', 'openai');
    type(renderer, 'url', 'https://proxy.example/v1');
    click(renderer, 'save');
    expect(harness.saves).toEqual([{ kind: 'pi-override', provider: 'openai', baseUrl: 'https://proxy.example/v1', create: true }]);
  });

  it('keeps the stored key when an edit leaves the key field untouched', () => {
    const renderer = mount();
    click(renderer, 'edit', 1);
    expect(field(renderer, 'name').props.disabled).toBe(true);
    expect(field(renderer, 'kind')).toBeUndefined();
    expect(field(renderer, 'key').props.value).toBe('');
    type(renderer, 'url', 'http://127.0.0.1:8200');
    click(renderer, 'save');

    expect(harness.saves).toEqual([{
      kind: 'pi-custom', provider: 'my-vllm', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:8200', models: ['Model-27B'],
    }]);
  });

  it('refuses to save a draft the server would reject', () => {
    const renderer = mount();
    click(renderer, 'new');
    type(renderer, 'name', 'bad name');
    type(renderer, 'url', 'ftp://box');
    const save = renderer.root.findAll(node => node.props['data-conn-action'] === 'save')[0];

    expect(save.props.disabled).toBe(true);
    expect(harness.saves).toEqual([]);
  });

  it('deletes only on the second click, naming the effect on sessions first', () => {
    const renderer = mount();
    click(renderer, 'delete');
    expect(harness.removals).toEqual([]);
    expect(renderer.root.findAll(node => node.props['data-conn-risk'] === '' && typeof node.type !== 'string')).toHaveLength(1);

    click(renderer, 'delete');
    expect(harness.removals).toEqual([{ backend: 'claude', id: 'api' }]);
  });
});
