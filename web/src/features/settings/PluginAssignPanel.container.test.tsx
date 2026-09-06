// input:  mounted assignment control, tRPC mocks, toast capture
// output: MCP ack, refresh, dirty-guard, and conflict tests for assignment
// pos:    Plugin assignment React Query integration regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginsAssignArgs, PluginsListReturn, ThreadTemplateDetail, ThreadTemplateEntry, UiPluginCatalogEntry,
} from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { ThemeProvider } from '@/theme';

const adapter = vi.hoisted(() => ({
  configFails: true,
  currentData: null as PluginsListReturn | null,
  failRefresh: false,
  refreshGate: null as Promise<void> | null,
  assignImpl: vi.fn<(args: PluginsAssignArgs) => Promise<unknown>>(),
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

vi.mock('@/features/auth/LoginFlowProvider', () => ({
  useLoginFlow: () => ({ openLogin: () => {} }),
}));

vi.mock('@/design', async importOriginal => {
  const actual = await importOriginal<typeof import('@/design')>();
  return {
    ...actual,
    Select: ({ options, value, disabled, onValueChange, ...props }: any) => (
      <div data-select-control data-select-value={String(value)} data-select-disabled={disabled ? 'true' : 'false'} {...props}>
        {options.map((option: any) => (
          <button
            key={String(option.value)}
            type="button"
            disabled={disabled || option.disabled}
            onClick={() => onValueChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    ),
    Modal: ({ open, layer, children, footer }: any) => (open ? <div data-modal-layer={String(layer)}>{children}{footer}</div> : null),
    useToast: () => ({ toast: adapter.toast }),
  };
});

function staticQuery(key: string, value?: unknown, error?: string) {
  return {
    queryOptions: () => ({
      queryKey: [key, {}],
      queryFn: async () => {
        if (error) throw new Error(error);
        return value;
      },
    }),
    queryFilter: () => ({ queryKey: [key, {}] }),
  };
}

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    config: { get: configQuery(), set: staticMutation() },
    cost: { summary: staticQuery('cost.summary', {}) },
    approvals: { request: staticMutation() },
    threadTemplates: {
      get: staticQuery('threadTemplates.get', templateEntries()),
      detail: templateDetailQuery(),
      validate: staticMutation(),
      save: staticMutation(),
      remove: staticMutation(),
    },
    plugins: { list: pluginListQuery(), assign: {
      mutationOptions: () => ({ mutationFn: (args: PluginsAssignArgs) => adapter.assignImpl(args) }),
    } },
  }),
}));

function configQuery() {
  return {
    queryOptions: () => ({
      queryKey: ['config.get', {}],
      queryFn: async () => {
        if (adapter.configFails) throw new Error('config unavailable');
        return {} as never;
      },
    }),
    queryFilter: () => ({ queryKey: ['config.get', {}] }),
  };
}

function templateEntries(): ThreadTemplateEntry[] {
  return [{ kind: 'agent', name: 'writer', description: null, body: { name: 'writer' }, valid: true, errorCount: 0, origin: 'custom' }];
}

function templateDetail(): ThreadTemplateDetail {
  return {
    kind: 'agent', name: 'writer', description: null, body: { name: 'writer' },
    filePath: '/tmp/writer.json', origin: 'custom', sha256: 'hash-agent',
    errors: [], warnings: [], usedByTemplates: [], runningThreads: 0, referencingTasks: 0, expanded: null,
  };
}

function templateDetailQuery() {
  return {
    queryOptions: (params: unknown) => ({
      queryKey: ['threadTemplates.detail', params],
      queryFn: async () => templateDetail(),
    }),
    queryFilter: (params: unknown) => ({ queryKey: ['threadTemplates.detail', params] }),
  };
}

function staticMutation() {
  return { mutationOptions: () => ({ mutationFn: async () => ({}) }) };
}

function pluginListQuery() {
  return {
    queryOptions: () => ({ queryKey: ['plugins.list', {}], queryFn: readPluginData }),
    queryFilter: () => ({ queryKey: ['plugins.list', {}] }),
  };
}

async function readPluginData(): Promise<PluginsListReturn> {
  if (adapter.failRefresh) throw new Error('refresh denied');
  if (adapter.refreshGate) await adapter.refreshGate;
  if (!adapter.currentData) throw new Error('plugins missing');
  return adapter.currentData;
}

import { PluginAssignPanel } from './PluginAssignPanel';
import { SettingsModal } from './SettingsModal';

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
    skills: [],
    mcp: { status: 'missing', servers: [] },
    issues: [],
    ...over,
  };
}

function listData(): PluginsListReturn {
  return {
    plugins: [
      plugin('alpha'),
      plugin('beta'),
      plugin('mcp-plugin', {
        manifest: { source: 'root', name: 'MCP', version: '2.0.0' },
        mcp: { status: 'valid', servers: [{ name: 'local', type: 'stdio', summary: { command: './bin/server', argsCount: 1, envKeys: ['TOKEN'] } }] },
      }),
    ],
    targets: [{
      kind: 'agent',
      name: 'writer',
      editable: true,
      baseHash: 'hash-agent',
      managedPluginIds: ['alpha'],
      unmanagedPluginCount: 0,
    }],
  };
}

function mount(queryClient: QueryClient): ReactTestRenderer {
  return create(
    <QueryClientProvider client={queryClient}>
      <LangProvider><PluginAssignPanel scope={{ kind: 'agent', name: 'writer' }} /></LangProvider>
    </QueryClientProvider>,
  );
}

function mountSettings(
  queryClient: QueryClient,
  onClose: () => void = () => {},
): ReactTestRenderer {
  return create(
    <QueryClientProvider client={queryClient}>
      <LangProvider><ThemeProvider>
        <SettingsModal open onClose={onClose} />
      </ThemeProvider></LangProvider>
    </QueryClientProvider>,
  );
}

function findTextButton(renderer: ReactTestRenderer, text: string) {
  return renderer.root.findAll(node => node.type === 'button' && node.children.join('') === text)[0];
}

function pluginToggle(renderer: ReactTestRenderer, id: string) {
  const row = renderer.root.findByProps({ 'data-plugin-row': id });
  return row.findAll(node => node.props.role === 'switch')[0];
}

async function ready(renderer: ReactTestRenderer) {
  await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-action': 'save' }).length).toBeGreaterThan(0));
}

async function click(node: { props: { onClick?: () => void } }) {
  await act(async () => { node.props.onClick?.(); });
}

async function cleanup(
  renderer: ReactTestRenderer,
  queryClient: QueryClient,
): Promise<void> {
  await queryClient.cancelQueries();
  act(() => renderer.unmount());
  queryClient.clear();
}

beforeEach(() => {
  adapter.configFails = true;
  adapter.currentData = listData();
  adapter.failRefresh = false;
  adapter.refreshGate = null;
  adapter.assignImpl.mockReset();
  adapter.toast.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function prepareAssignedData(): void {
  const next = listData();
  const target = next.targets[0] as Extract<PluginsListReturn['targets'][number], { kind: 'agent' }>;
  next.targets = [{ ...target, baseHash: 'hash-next', managedPluginIds: ['alpha', 'mcp-plugin'] }];
  adapter.assignImpl.mockImplementation(async () => {
    adapter.currentData = next;
    return { changed: true, baseHash: 'hash-next' };
  });
}

async function confirmMcpSave(renderer: ReactTestRenderer): Promise<void> {
  await ready(renderer);
  await click(pluginToggle(renderer, 'mcp-plugin'));
  await click(findTextButton(renderer, 'Save'));
  expect(renderer.root.findByProps({ 'data-modal-layer': 'nested' })).toBeTruthy();
  await click(findTextButton(renderer, 'Acknowledge and save'));
  await vi.waitFor(() => expect(adapter.assignImpl).toHaveBeenCalledOnce());
}

function expectMcpAssignment(invalidate: unknown): void {
  expect(adapter.assignImpl).toHaveBeenCalledWith({
    target: { kind: 'agent', name: 'writer', baseHash: 'hash-agent' },
    pluginIds: ['alpha', 'mcp-plugin'],
    acknowledgeMcp: true,
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['plugins.list', {}] });
  expect(adapter.toast).toHaveBeenCalledWith({ title: 'Plugin assignments saved', tone: 'done' });
}

describe('Plugins Settings shell integration', () => {
  it('renders Plugins even when the independent config query fails', async () => {
    const queryClient = testQueryClient();
    const renderer = mountSettings(queryClient);

    const nav = renderer.root.findByProps({ 'data-settings-nav': 'plugins' });
    await act(async () => { nav.props.onClick(); });
    await vi.waitFor(() => {
      expect(renderer.root.findAllByProps({ 'data-settings-panel': 'plugins' })).toHaveLength(1);
    });
    expect(renderer.root.findAllByProps({ 'data-plugins-error': '' })).toHaveLength(0);
    await cleanup(renderer, queryClient);
  });

});

describe('Settings dirty guard', () => {
  it('blocks leaving while an assignment draft is dirty inside the templates editor', async () => {
    adapter.configFails = false;
    const queryClient = testQueryClient();
    const renderer = mountSettings(queryClient);

    const templatesNav = renderer.root.findByProps({ 'data-settings-nav': 'templates' });
    expect(templatesNav.type).toBe('button');
    await act(async () => { templatesNav.props.onClick(); });

    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-template-row': 'agent:writer' })).toHaveLength(1));
    await click(renderer.root.findByProps({ 'data-template-row': 'agent:writer' }));
    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-template-tab': 'plugins' })).toHaveLength(1));
    await click(renderer.root.findByProps({ 'data-template-tab': 'plugins' }));
    // The templates editor owns a `data-action="save"` of its own, so `ready()` would resolve
    // before the embedded assignment control has any rows. Wait on a row instead.
    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-plugin-row': 'beta' })).not.toHaveLength(0));

    await click(pluginToggle(renderer, 'beta'));

    const appearance = renderer.root.findByProps({ 'data-settings-nav': 'appearance' });
    const close = renderer.root.findAllByType('button')
      .find((node) => node.children.join('') === 'esc');
    expect(appearance.props.disabled).toBe(true);
    expect(close?.props.disabled).toBe(true);
    await cleanup(renderer, queryClient);
  });
});

describe('PluginAssignPanel container', () => {
  it('runs add-MCP through ack, assignment, invalidation, and refresh', async () => {
    prepareAssignedData();
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const renderer = mount(queryClient);

    await confirmMcpSave(renderer);
    expectMcpAssignment(invalidate);
    await cleanup(renderer, queryClient);
  });

});

describe('PluginAssignPanel refresh lock', () => {
  it('keeps controls disabled until the post-save refresh settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapter.assignImpl.mockImplementation(async () => {
      adapter.refreshGate = gate;
      return { changed: true, baseHash: 'hash-next' };
    });
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);
    await ready(renderer);

    await click(pluginToggle(renderer, 'beta'));
    await click(findTextButton(renderer, 'Save'));
    await vi.waitFor(() => {
      expect(renderer.root.findByProps({ 'data-action': 'save' }).props['data-disabled']).toBe('true');
    });
    release();
    await cleanup(renderer, queryClient);
  });

});

describe('PluginAssignPanel conflict refresh', () => {
  it('preserves the dirty draft as stale after an assignment conflict', async () => {
    const fresh = listData();
    fresh.targets[0] = { ...fresh.targets[0], baseHash: 'hash-next' } as PluginsListReturn['targets'][number];
    adapter.assignImpl.mockRejectedValue(new Error('changed on disk'));
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);

    await ready(renderer);
    await click(pluginToggle(renderer, 'beta'));
    adapter.currentData = fresh;
    await click(findTextButton(renderer, 'Save'));
    await vi.waitFor(() => expect(renderer.root.findAllByProps({ 'data-plugin-conflict': '' })).toHaveLength(1));

    expect(pluginToggle(renderer, 'beta').props['aria-checked']).toBe(true);
    expect(renderer.root.findByProps({ 'data-action': 'save' }).props['data-disabled']).toBe('true');
    expect(renderer.root.findByProps({ 'data-action': 'reset' }).props['data-disabled']).toBe('false');
    await cleanup(renderer, queryClient);
  });
});

describe('PluginAssignPanel conflict refresh errors', () => {
  it('toasts a localized refresh failure when a conflict refresh also fails', async () => {
    adapter.assignImpl.mockRejectedValue(new Error('changed on disk'));
    const queryClient = testQueryClient();
    const renderer = mount(queryClient);

    await ready(renderer);
    await click(pluginToggle(renderer, 'beta'));
    adapter.failRefresh = true;
    await click(findTextButton(renderer, 'Save'));
    await vi.waitFor(() => expect(adapter.toast).toHaveBeenCalledWith({
      title: 'Plugin refresh failed: refresh denied', tone: 'failed',
    }));
    await cleanup(renderer, queryClient);
  });
});
