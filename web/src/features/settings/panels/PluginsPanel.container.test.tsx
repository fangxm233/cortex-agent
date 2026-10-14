import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginsListReturn,
  PluginsMcpRead,
  PluginsSkillFile,
  UiPluginCatalogEntry,
  MutateArgs,
} from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const adapter = vi.hoisted(() => ({
  skillFile: null as PluginsSkillFile | null,
  mcpRead: null as PluginsMcpRead | null,
  skillWrite: vi.fn<(a: MutateArgs<'plugins.skillWrite'>) => Promise<unknown>>(),
  skillCreate: vi.fn<(a: MutateArgs<'plugins.skillCreate'>) => Promise<unknown>>(),
  skillMove: vi.fn<(a: MutateArgs<'plugins.skillMove'>) => Promise<unknown>>(),
  skillRemove: vi.fn<(a: MutateArgs<'plugins.skillRemove'>) => Promise<unknown>>(),
  skillRevert: vi.fn<(a: MutateArgs<'plugins.skillRevert'>) => Promise<unknown>>(),
  create: vi.fn<(a: MutateArgs<'plugins.create'>) => Promise<unknown>>(),
  remove: vi.fn<(a: MutateArgs<'plugins.remove'>) => Promise<unknown>>(),
  convert: vi.fn<(a: MutateArgs<'plugins.convertToPortable'>) => Promise<unknown>>(),
  mcpWrite: vi.fn<(a: MutateArgs<'plugins.mcpWrite'>) => Promise<unknown>>(),
  toast: vi.fn(),
}));

vi.mock('@radix-ui/react-dialog', () => ({
  Root: ({ open, children }: any) => open ? <div>{children}</div> : null,
  Portal: ({ children }: any) => <>{children}</>,
  Overlay: () => null,
  Content: ({ children }: any) => <div>{children}</div>,
  Title: ({ children }: any) => <h1>{children}</h1>,
  Description: ({ children }: any) => <p>{children}</p>,
  Close: ({ children }: any) => <button type="button">{children}</button>,
  Trigger: ({ children }: any) => <>{children}</>,
}));

vi.mock('@/design', async importOriginal => {
  const actual = await importOriginal<typeof import('@/design')>();
  return {
    ...actual,
    Select: ({ options, value, onValueChange, ...props }: any) => (
      <div data-select-control data-select-value={String(value)} {...props}>
        {options.map((option: any) => (
          <button key={String(option.value)} type="button" onClick={() => onValueChange(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    ),
    Modal: ({ open, children, footer }: any) => (open ? <div data-modal="">{children}{footer}</div> : null),
    useToast: () => ({ toast: adapter.toast }),
  };
});

function paramQuery<T>(key: string, read: () => T | null) {
  return {
    queryOptions: (params: unknown) => ({
      queryKey: [key, params],
      queryFn: async () => {
        const value = read();
        if (!value) throw new Error(`${key} missing`);
        return value;
      },
    }),
    queryFilter: (params: unknown) => ({ queryKey: [key, params] }),
  };
}

function mutation<A>(impl: (args: A) => Promise<unknown>) {
  return { mutationOptions: () => ({ mutationFn: impl }) };
}

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    plugins: {
      list: {
        queryOptions: () => ({ queryKey: ['plugins.list', {}], queryFn: async () => listData() }),
        queryFilter: () => ({ queryKey: ['plugins.list', {}] }),
      },
      skillFile: paramQuery('plugins.skillFile', () => adapter.skillFile),
      mcpRead: paramQuery('plugins.mcpRead', () => adapter.mcpRead),
      assign: mutation(async () => ({})),
      skillWrite: mutation(adapter.skillWrite),
      skillCreate: mutation(adapter.skillCreate),
      skillMove: mutation(adapter.skillMove),
      skillRemove: mutation(adapter.skillRemove),
      skillRevert: mutation(adapter.skillRevert),
      create: mutation(adapter.create),
      remove: mutation(adapter.remove),
      convertToPortable: mutation(adapter.convert),
      mcpWrite: mutation(adapter.mcpWrite),
    },
  }),
}));

import { PluginsPanel } from './PluginsPanel';

function plugin(id: string, over: Partial<UiPluginCatalogEntry> = {}): UiPluginCatalogEntry {
  return {
    id,
    kind: 'portable',
    scope: 'always',
    origin: 'local',
    rootDir: `plugins/${id}`,
    valid: true,
    assignable: true,
    manifest: { source: 'root', name: id, version: '1.0.0' },
    skills: [{ name: 'review', description: 'Review a change.', origin: 'local' }],
    mcp: { status: 'missing', servers: [] },
    issues: [],
    ...over,
  };
}

function listData(): PluginsListReturn {
  return {
    plugins: [
      plugin('alpha'),
      plugin('legacy', { kind: 'legacy', skills: [] }),
      plugin('shipped', {
        origin: 'builtin',
        skills: [
          { name: 'notes', description: 'Edited.', origin: 'overridden' },
          { name: 'schedule', description: 'Shipped.', origin: 'builtin' },
        ],
      }),
    ],
    targets: [],
  };
}

const SKILL_SOURCE = '---\nname: review\ndescription: Review a change.\n---\n\n# review\n';

function mount(queryClient: QueryClient): ReactTestRenderer {
  return create(
    <QueryClientProvider client={queryClient}>
      <LangProvider><PluginsPanel /></LangProvider>
    </QueryClientProvider>,
  );
}

function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

async function click(node: { props: { onClick?: () => void } }) {
  await act(async () => { node.props.onClick?.(); });
}

async function change(node: { props: { onChange?: (event: unknown) => void } }, value: string) {
  await act(async () => { node.props.onChange?.({ target: { value } }); });
}

function byAction(renderer: ReactTestRenderer, action: string) {
  return renderer.root.findAllByProps({ 'data-action': action })
    .filter((node) => node.type === 'button')[0];
}

function byField(renderer: ReactTestRenderer, field: string) {
  return renderer.root.findAllByProps({ 'data-field': field })
    .filter((node) => typeof node.type === 'string')[0];
}

/** findAllByProps matches the component instance and its host element, so assert on presence. */
async function ready(renderer: ReactTestRenderer) {
  await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-plugin-detail': 'alpha' })).not.toHaveLength(0));
}

async function openTab(renderer: ReactTestRenderer, tab: string) {
  await click(renderer.root.findByProps({ 'data-plugin-tab': tab }));
}

/** React Query hands the mutationFn a context object as a second argument; only the payload matters. */
function payloadOf(fn: { mock: { calls: unknown[][] } }): unknown {
  return fn.mock.calls[0]?.[0];
}

async function cleanup(renderer: ReactTestRenderer, queryClient: QueryClient) {
  await queryClient.cancelQueries();
  act(() => renderer.unmount());
  queryClient.clear();
}

beforeEach(() => {
  adapter.skillFile = {
    pluginId: 'alpha', skill: 'review', path: 'plugins/alpha/skills/review/SKILL.md',
    content: SKILL_SOURCE, origin: 'local', baseHash: 'a'.repeat(64),
  };
  adapter.mcpRead = {
    pluginId: 'alpha',
    supported: true,
    servers: [
      { name: 'local', type: 'stdio', command: './bin/server', args: ['--verbose'], envKeys: ['TOKEN'] },
    ],
  };
  for (const fn of [adapter.skillWrite, adapter.skillCreate, adapter.skillMove, adapter.skillRemove, adapter.skillRevert,
    adapter.create, adapter.remove, adapter.convert, adapter.mcpWrite, adapter.toast]) {
    fn.mockReset();
  }
  adapter.skillWrite.mockResolvedValue({ baseHash: 'b'.repeat(64) });
  adapter.mcpWrite.mockResolvedValue(adapter.mcpRead);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('skill editing', () => {
  it('sends the hash it opened with, so a stale editor cannot clobber a newer file', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await openTab(renderer, 'skills');
    await click(byAction(renderer, 'skill-open'));
    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-plugin-skill-editor': 'review' })).not.toHaveLength(0));

    await change(renderer.root.findByProps({ 'data-plugin-skill-source': 'review' }), `${SKILL_SOURCE}edited\n`);
    await click(byAction(renderer, 'skill-save'));

    expect(payloadOf(adapter.skillWrite)).toEqual({
      pluginId: 'alpha', skill: 'review', content: `${SKILL_SOURCE}edited\n`, baseHash: 'a'.repeat(64),
    });
    await cleanup(renderer, queryClient);
  });

  it('keeps Save inert until the text actually differs', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await openTab(renderer, 'skills');
    await click(byAction(renderer, 'skill-open'));
    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-plugin-skill-editor': 'review' })).not.toHaveLength(0));

    expect(byAction(renderer, 'skill-save').props.disabled).toBe(true);
    await cleanup(renderer, queryClient);
  });

  it('refuses to create a skill without a usable name and description', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await openTab(renderer, 'skills');

    await change(byField(renderer, 'skill-name'), 'Not Canonical');
    await change(byField(renderer, 'skill-description'), 'something');
    expect(byAction(renderer, 'skill-create').props.disabled).toBe(true);

    await change(byField(renderer, 'skill-name'), 'summarize');
    await click(byAction(renderer, 'skill-create'));
    expect(payloadOf(adapter.skillCreate)).toEqual({
      pluginId: 'alpha', skill: 'summarize', description: 'something',
    });
    await cleanup(renderer, queryClient);
  });

  it('deletes only after the confirmation step', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await openTab(renderer, 'skills');

    await click(byAction(renderer, 'skill-delete'));
    expect(adapter.skillRemove).not.toHaveBeenCalled();

    await click(byAction(renderer, 'skill-delete-confirm'));
    expect(payloadOf(adapter.skillRemove)).toEqual({ pluginId: 'alpha', skill: 'review' });
    await cleanup(renderer, queryClient);
  });
});

describe('built-in skills', () => {
  it('cannot be moved or deleted, and the buttons say why', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await click(renderer.root.findByProps({ 'data-plugin-item': 'shipped' }));
    await openTab(renderer, 'skills');

    const rows = renderer.root.findAllByProps({ 'data-action': 'skill-move' }).filter((node) => node.type === 'button');
    expect(rows).toHaveLength(2);
    for (const action of ['skill-move', 'skill-delete']) {
      for (const button of renderer.root.findAllByProps({ 'data-action': action }).filter((node) => node.type === 'button')) {
        expect(button.props.disabled).toBe(true);
        expect(String(button.props.title)).toMatch(/cannot be moved or deleted/);
      }
    }
    expect(renderer.root.findAllByProps({ 'data-plugin-builtin-note': '' })).not.toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-plugin-skill-origin': 'overridden' })).not.toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-plugin-skill-origin': 'builtin' })).not.toHaveLength(0);
    await cleanup(renderer, queryClient);
  });

  it('offers revert only for an edited one, after a confirmation step', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await click(renderer.root.findByProps({ 'data-plugin-item': 'shipped' }));
    await openTab(renderer, 'skills');

    expect(renderer.root.findAllByProps({ 'data-action': 'skill-revert' }).filter((node) => node.type === 'button')).toHaveLength(1);
    await click(byAction(renderer, 'skill-revert'));
    expect(adapter.skillRevert).not.toHaveBeenCalled();

    await click(byAction(renderer, 'skill-revert-confirm'));
    expect(payloadOf(adapter.skillRevert)).toEqual({ pluginId: 'shipped', skill: 'notes' });
    await cleanup(renderer, queryClient);
  });

  it('says in the editor that saving keeps the user version in place of the built-in one', async () => {
    adapter.skillFile = { ...adapter.skillFile!, pluginId: 'shipped', skill: 'schedule', origin: 'builtin' };
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await click(renderer.root.findByProps({ 'data-plugin-item': 'shipped' }));
    await openTab(renderer, 'skills');
    const open = renderer.root.findAllByProps({ 'data-action': 'skill-open' }).filter((node) => node.type === 'button');
    await click(open[1]);

    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-plugin-skill-note': 'builtin' })).not.toHaveLength(0));
    await cleanup(renderer, queryClient);
  });
});

describe('plugin lifecycle', () => {
  it('creates a plugin from a canonical id only', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);

    await click(byAction(renderer, 'plugin-create'));
    await change(byField(renderer, 'plugin-id'), 'Bad Id');
    expect(byAction(renderer, 'plugin-create-confirm').props.disabled).toBe(true);

    await change(byField(renderer, 'plugin-id'), 'gamma');
    await click(byAction(renderer, 'plugin-create-confirm'));
    expect(payloadOf(adapter.create)).toEqual({ id: 'gamma', description: undefined });
    await cleanup(renderer, queryClient);
  });

  it('blocks deleting a built-in plugin and says why', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await click(renderer.root.findByProps({ 'data-plugin-item': 'shipped' }));
    await click(byAction(renderer, 'plugin-delete'));

    expect(byAction(renderer, 'plugin-delete-confirm').props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-plugin-delete-builtin': '' })).not.toHaveLength(0);
    await cleanup(renderer, queryClient);
  });

  it('deletes a local plugin once confirmed', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await click(byAction(renderer, 'plugin-delete'));
    expect(adapter.remove).not.toHaveBeenCalled();

    await click(byAction(renderer, 'plugin-delete-confirm'));
    expect(payloadOf(adapter.remove)).toEqual({ id: 'alpha' });
    await cleanup(renderer, queryClient);
  });

  it('converts a legacy plugin rather than showing it an MCP form', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await click(renderer.root.findByProps({ 'data-plugin-item': 'legacy' }));
    await openTab(renderer, 'mcp');

    await click(byAction(renderer, 'mcp-convert'));
    expect(payloadOf(adapter.convert)).toEqual({ id: 'legacy' });
    await cleanup(renderer, queryClient);
  });
});

describe('MCP servers', () => {
  it('keeps a stored secret by sending null and never renders its value', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await openTab(renderer, 'mcp');
    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-plugin-secret': 'TOKEN' })).not.toHaveLength(0));

    await change(byField(renderer, 'mcp-command'), './bin/other');
    await click(byAction(renderer, 'mcp-save'));

    expect(payloadOf(adapter.mcpWrite)).toEqual({
      pluginId: 'alpha',
      servers: [{ name: 'local', type: 'stdio', command: './bin/other', args: ['--verbose'], env: { TOKEN: null } }],
    });
    await cleanup(renderer, queryClient);
  });

  it('sends a replaced secret as a value once the operator asks to replace it', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await openTab(renderer, 'mcp');
    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-plugin-secret': 'TOKEN' })).not.toHaveLength(0));

    await click(byAction(renderer, 'secret-replace'));
    await change(byField(renderer, 'secret-value'), 'fresh-token');
    await click(byAction(renderer, 'mcp-save'));

    expect(payloadOf(adapter.mcpWrite)).toEqual({
      pluginId: 'alpha',
      servers: [{ name: 'local', type: 'stdio', command: './bin/server', args: ['--verbose'], env: { TOKEN: 'fresh-token' } }],
    });
    await cleanup(renderer, queryClient);
  });

  it('will not save a server that has no name', async () => {
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);
    await openTab(renderer, 'mcp');
    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-plugin-secret': 'TOKEN' })).not.toHaveLength(0));

    await change(byField(renderer, 'mcp-name'), '');
    expect(byAction(renderer, 'mcp-save').props.disabled).toBe(true);
    await cleanup(renderer, queryClient);
  });
});
