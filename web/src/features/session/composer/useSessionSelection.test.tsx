import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSnapshot, EngineSelection, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { modelKey } from '@/lib/model-selection';

const harness = vi.hoisted(() => ({
  config: null as unknown, catalog: null as unknown, connections: [] as unknown[], status: undefined as unknown, writes: vi.fn(), invalidate: vi.fn(), fetch: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { kind: string }) => {
    if (opts.kind === 'connections') return { data: harness.connections, isLoading: false };
    if (opts.kind === 'status') return { data: harness.status, isLoading: false };
    return { data: opts.kind === 'config' ? harness.config : harness.catalog, isLoading: !harness.catalog };
  },
  useQueryClient: () => ({ invalidateQueries: harness.invalidate, fetchQuery: harness.fetch }),
  useMutation: (opts: { kind: string; onSuccess: () => void }) => ({
    mutate: (input: unknown) => { harness.writes(opts.kind, input); opts.onSuccess(); },
  }),
}));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => {
  const mutation = (kind: string) => ({ mutationOptions: (options: object) => ({ kind, ...options }) });
  return {
    config: { get: { queryOptions: () => ({ kind: 'config' }), queryFilter: () => ({ kind: 'config' }) } },
    connections: { list: { queryOptions: () => ({ kind: 'connections' }) } },
    auth: { status: { queryOptions: () => ({ kind: 'status' }) } },
    models: {
      catalog: { queryOptions: () => ({ kind: 'catalog' }) },
      favorites: { add: mutation('add'), remove: mutation('remove') },
    },
    sessions: { setSelection: mutation('selection'), setAgent: mutation('agent'), list: { queryFilter: () => ({ kind: 'sessions' }) } },
  };
} }));

import { useSessionSelection, type SessionSelection, type SessionSelectionInput } from './useSessionSelection';

const current: EngineSelection = { backend: 'claude', provider: null, model: 'claude-opus', thinking: 'high', connection: 'subscription' };
const other = { backend: 'pi' as const, provider: 'remote', model: 'remote-model' };
const catalog: ModelCatalogSnapshot = {
  piPending: false, thinkingLevels: { claude: ['low', 'high'], pi: ['high'] },
  routes: [
    { endpoint: 'anthropic', backend: 'claude', provider: null, connections: ['api', 'subscription'], models: ['claude-opus', 'claude-sonnet'], source: 'connection' },
    { endpoint: 'remote', backend: 'pi', provider: 'remote', connections: [], models: ['remote-model'], source: 'connection' },
  ],
};
let value: SessionSelection;
function Probe({ input }: { input: SessionSelectionInput }) { value = useSessionSelection(input); return null; }
function mount(patch: Partial<SessionSelectionInput> = {}): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  const input: SessionSelectionInput = {
    sessionId: 's1', currentSelection: current, currentAgent: null, hasHistory: false,
    isDraft: false, draftSelection: { selection: null }, setDraftSelection: vi.fn(), pendingCreatedSession: null,
    ...patch,
  };
  act(() => { tree = create(<LangProvider><Probe input={input} /></LangProvider>); });
  return tree;
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.config = { models: { default: current, favorites: [current, other], memory: {} }, agents: [{ name: 'main' }] } as Partial<ConfigSnapshot>;
  harness.catalog = catalog;
  harness.fetch.mockResolvedValue(catalog);
  harness.connections = [];
  harness.status = undefined;
});

describe('shared selection controller', () => {
  it('fetches the catalog for an uncached Claude pick and keeps the connection where it serves the model', async () => {
    harness.catalog = null;
    const sonnet = { backend: 'claude' as const, provider: null, model: 'claude-sonnet' };
    (harness.config as ConfigSnapshot).models.favorites = [current, sonnet];
    const tree = mount();
    expect(value.favoriteOptions).toHaveLength(2);
    await act(async () => value.pickFavorite(value.favoriteOptions[1]!));
    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(harness.writes).toHaveBeenCalledWith('selection', { sessionId: 's1', selection: { ...sonnet, thinking: null, connection: 'subscription' } });
    act(() => tree.unmount());
  });
  it('names the default login by its email, else by the generic name, and keeps the Default row apart', () => {
    harness.connections = [
      { id: 'subscription', backend: 'claude', kind: 'subscription', label: 'Claude subscription' },
      { id: 'api', backend: 'claude', kind: 'key', label: 'api' },
    ];
    const generic = mount();
    expect(value.connectionOptions.map(option => option.label)).toEqual(['Default (api)', 'api', 'Claude subscription']);
    act(() => generic.unmount());
    harness.status = { accounts: [{ backend: 'claude', connection: null, identity: { email: 'me@home.com' } }] };
    const named = mount();
    expect(value.connectionOptions.map(option => option.label)).toEqual(['Default (api)', 'api', 'me@home.com']);
    expect(value.rootRows.find(row => row.key === 'connection')?.value).toBe('me@home.com');
    act(() => named.unmount());
  });
  it('uses remembered thinking for a PI pick without requiring the catalog', async () => {
    harness.catalog = null;
    (harness.config as ConfigSnapshot).models.memory[modelKey(other)] = { thinking: 'high' };
    const tree = mount();
    await act(async () => value.pickFavorite(value.favoriteOptions[1]!));
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.writes).toHaveBeenCalledWith('selection', { sessionId: 's1', selection: { ...other, thinking: 'high', connection: null } });
    act(() => tree.unmount());
  });
  it('keeps all engine fields when choosing default thinking and blocks a live backend change', async () => {
    const tree = mount({ hasHistory: true });
    act(() => value.pickThinking(null));
    expect(harness.writes).toHaveBeenCalledWith('selection', { sessionId: 's1', selection: { ...current, thinking: null } });
    harness.writes.mockClear();
    await act(async () => value.pickFavorite(value.favoriteOptions[1]!));
    expect(harness.writes).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
  it('stars edit favorites independently without selecting a model', () => {
    const tree = mount();
    const option = value.modelGroups[0]!.options[1]!;
    act(() => value.toggleFavorite(option));
    expect(harness.writes).toHaveBeenCalledWith('add', { backend: 'claude', provider: undefined, model: 'claude-sonnet' });
    expect(harness.writes).toHaveBeenCalledTimes(1);
    expect(harness.invalidate).toHaveBeenCalledWith({ kind: 'config' });
    act(() => tree.unmount());
  });
  it('writes draft changes locally and preserves the independent agent axis', async () => {
    const setDraftSelection = vi.fn();
    const tree = mount({ isDraft: true, draftSelection: { selection: current }, setDraftSelection });
    await act(async () => value.pickModel(value.modelGroups[1]!.options[0]!));
    expect(setDraftSelection).toHaveBeenCalledWith({ selection: { ...other, thinking: null, connection: null } });
    act(() => value.pickAgent('main'));
    expect(setDraftSelection).toHaveBeenLastCalledWith({ agentName: 'main' });
    expect(harness.writes).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
