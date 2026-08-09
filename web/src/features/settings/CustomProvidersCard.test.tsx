// input:  CustomProvidersCard with stubbed custom provider queries and mutations
// output: list rendering, save payload and delete-confirmation tests
// pos:    Verifies the desktop custom provider surface
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomProviderView } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  saves: [] as unknown[],
  removals: [] as unknown[],
  providers: [] as unknown[],
}));

const PROVIDER: CustomProviderView = {
  name: 'my-vllm',
  api: 'anthropic-messages',
  models: [{ id: 'Model-27B' }],
  upstreamUrl: 'http://127.0.0.1:8100',
  hasApiKey: true,
  routed: true,
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
    auth: {
      status: query('auth.status'),
      customProviders: query('auth.customProviders'),
      upsertCustomProvider: mutation('auth.upsertCustomProvider'),
      removeCustomProvider: mutation('auth.removeCustomProvider'),
    },
  }) };
});

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: () => ({ data: harness.providers, isLoading: false, isError: false, error: null }),
  useMutation: (options: any) => ({
    mutate: (variables: unknown) => {
      if (options.__kind === 'auth.upsertCustomProvider') harness.saves.push(variables);
      else harness.removals.push(variables);
      options.onSuccess?.({}, variables);
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

import { CustomProvidersCard } from './CustomProvidersCard';

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><CustomProvidersCard /></LangProvider>); });
  return renderer;
}

function click(renderer: ReactTestRenderer, action: string, index = 0): void {
  const button = renderer.root.findAll(node => node.props['data-cpv-action'] === action)[index];
  act(() => { button.props.onClick(); });
}

function field(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findAll(node => node.props['data-cpv-field'] === name)[0];
}

function type(renderer: ReactTestRenderer, name: string, value: string): void {
  const control = field(renderer, name);
  act(() => {
    if (control.props.onValueChange) control.props.onValueChange(value);
    else control.props.onChange({ target: { value } });
  });
}

beforeEach(() => {
  harness.saves = [];
  harness.removals = [];
  harness.providers = [PROVIDER];
});

describe('desktop custom providers', () => {
  it('lists a stored definition with its protocol, upstream and key state', () => {
    const html = JSON.stringify(mount().toJSON());

    expect(html).toContain('my-vllm');
    expect(html).toContain('anthropic-messages');
    expect(html).toContain('http://127.0.0.1:8100');
    expect(html).toContain('Model-27B');
    expect(html).toContain('key stored');
  });

  it('flags a definition the gateway does not route', () => {
    harness.providers = [{ ...PROVIDER, routed: false, upstreamUrl: null, hasApiKey: false }];

    const html = JSON.stringify(mount().toJSON());

    expect(html).toContain('no gateway route');
    expect(html).toContain('no key');
  });

  it('sends a new definition with the models the editor listed', () => {
    const renderer = mount();

    click(renderer, 'new');
    expect(renderer.root.findAllByProps({ 'data-select-control': true })).toHaveLength(1);
    type(renderer, 'name', 'my-proxy');
    type(renderer, 'api', 'openai-completions');
    type(renderer, 'url', 'https://proxy.example.com/v1');
    type(renderer, 'models', 'small\nlarge');
    click(renderer, 'save');

    expect(harness.saves).toEqual([{
      name: 'my-proxy',
      api: 'openai-completions',
      upstreamUrl: 'https://proxy.example.com/v1',
      models: [{ id: 'small' }, { id: 'large' }],
    }]);
  });

  it('keeps the stored key when an edit leaves the key field untouched', () => {
    const renderer = mount();

    click(renderer, 'edit');
    expect(field(renderer, 'name').props.disabled).toBe(true);
    expect(field(renderer, 'key').props.value).toBe('');
    type(renderer, 'url', 'http://127.0.0.1:8200');
    click(renderer, 'save');

    expect(harness.saves).toEqual([{
      name: 'my-vllm',
      api: 'anthropic-messages',
      upstreamUrl: 'http://127.0.0.1:8200',
      models: [{ id: 'Model-27B' }],
    }]);
  });

  it('refuses to save a draft the server would reject', () => {
    const renderer = mount();

    click(renderer, 'new');
    type(renderer, 'name', 'bad name');
    type(renderer, 'url', 'ftp://box');
    const save = renderer.root.findAll(node => node.props['data-cpv-action'] === 'save')[0];

    expect(save.props.disabled).toBe(true);
    expect(harness.saves).toEqual([]);
  });

  it('deletes only on the second click', () => {
    const renderer = mount();

    click(renderer, 'delete');
    expect(harness.removals).toEqual([]);

    click(renderer, 'delete');
    expect(harness.removals).toEqual([{ name: 'my-vllm' }]);
  });
});
