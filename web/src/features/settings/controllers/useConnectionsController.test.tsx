import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthStatusSnapshot, ConnectionView } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { useConnectionsController, type ConnectionsController } from './useConnectionsController';

const CUSTOM: ConnectionView = {
  id: 'my-vllm', backend: 'pi', provider: 'my-vllm', kind: 'custom', label: 'my-vllm', api: 'anthropic-messages',
  baseUrl: 'http://127.0.0.1:8100', billing: 'metered', authenticated: true, keyHint: 'sk-…abcd', models: ['Model-27B'],
};
const API: ConnectionView = {
  id: 'api', backend: 'claude', provider: null, kind: 'key', label: 'api', baseUrl: null, authStyle: 'x-api-key',
  billing: 'metered', authenticated: true, keyHint: 'sk-…wxyz', models: null,
};
const STATUS = { accounts: [{ backend: 'pi', provider: 'openai' }, { backend: 'pi', provider: 'my-vllm' }] } as AuthStatusSnapshot;

const adapter = vi.hoisted(() => ({
  list: vi.fn(),
  status: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));

function queryApi(kind: string, fetch: (input: unknown) => unknown) {
  return {
    queryOptions: (input: unknown) => ({ queryKey: [kind, input], queryFn: () => fetch(input) }),
    queryFilter: (input: unknown) => ({ queryKey: [kind, input] }),
  };
}

function mutationApi(run: (input: unknown) => unknown) {
  return { mutationOptions: (options: object) => ({ ...options, mutationFn: (input: unknown) => run(input) }) };
}

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    connections: {
      list: queryApi('connections.list', (input) => adapter.list(input)),
      upsert: mutationApi((input) => adapter.upsert(input)),
      remove: mutationApi((input) => adapter.remove(input)),
    },
    auth: { status: queryApi('auth.status', (input) => adapter.status(input)) },
    models: { catalog: queryApi('models.catalog', () => ({})) },
  }),
}));

vi.mock('@/design', () => ({
  useToast: () => ({ toast: adapter.toast }),
}));

let controller: ConnectionsController | null = null;

function Probe() {
  controller = useConnectionsController();
  return null;
}

async function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <LangProvider><Probe /></LangProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(controller?.rows.map(row => row.key)).toEqual(['claude:api', 'pi:my-vllm']));
  await vi.waitFor(() => expect(controller?.overridable).toEqual(['openai']));
  return { queryClient, invalidate, renderer };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const REFRESHES = [
  { queryKey: ['connections.list', {}] },
  { queryKey: ['auth.status', {}] },
  { queryKey: ['models.catalog', {}] },
];

beforeEach(() => {
  controller = null;
  vi.clearAllMocks();
  adapter.list.mockResolvedValue([API, CUSTOM]);
  adapter.status.mockResolvedValue(STATUS);
  adapter.upsert.mockResolvedValue({ connection: null });
  adapter.remove.mockResolvedValue({ removed: true });
});

describe('useConnectionsController', () => {
  it('loads the rows and derives create/edit drafts with canonical validation', async () => {
    const mounted = await mount();
    expect(controller?.kinds).toEqual(['claude', 'pi-override', 'pi-custom']);
    expect(controller?.rows[0].apiKeySlot).toBe(true);

    act(() => { controller?.openCreate(); });
    expect(controller?.creating).toBe(true);
    expect(controller?.errors).toEqual({ name: 'name-required', key: 'key-required' });
    act(() => { controller?.changeDraft({ ...controller!.draft!, name: 'api', key: 'sk-new' }); });
    expect(controller?.errors.name).toBe('name-taken');
    act(() => { controller?.save(); });
    expect(adapter.upsert).not.toHaveBeenCalled();

    act(() => { controller?.openEdit(controller!.rows[1]); });
    expect(controller?.creating).toBe(false);
    expect(controller?.draft).toMatchObject({
      kind: 'pi-custom', name: 'my-vllm', baseUrl: 'http://127.0.0.1:8100', key: '', models: 'Model-27B',
    });
    expect(controller?.errors).toEqual({});
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('saves a valid draft with save-local pending, the refreshes that follow it, close, and toast', async () => {
    const gate = deferred<unknown>();
    adapter.upsert.mockReturnValue(gate.promise);
    const mounted = await mount();
    act(() => {
      controller?.openCreate();
      controller?.changeDraft({
        kind: 'pi-custom', name: 'my-proxy', api: 'openai-completions', baseUrl: 'https://proxy.example/v1',
        authStyle: 'x-api-key', key: ' secret ', models: 'small\nlarge',
      });
    });

    act(() => { controller?.save(); });
    await vi.waitFor(() => expect(controller?.savePending).toBe(true));
    expect(controller?.removePending).toBe(false);
    expect(adapter.upsert).toHaveBeenCalledWith({
      kind: 'pi-custom', provider: 'my-proxy', api: 'openai-completions', baseUrl: 'https://proxy.example/v1',
      key: 'secret', models: ['small', 'large'], create: true,
    });

    gate.resolve({ connection: null });
    await vi.waitFor(() => expect(controller?.savePending).toBe(false));
    expect(controller?.draft).toBeNull();
    expect(mounted.invalidate.mock.calls.map(call => call[0])).toEqual(REFRESHES);
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('removes only on the second request with remove-local pending and exact success effects', async () => {
    const gate = deferred<{ removed: boolean }>();
    adapter.remove.mockReturnValue(gate.promise);
    const mounted = await mount();
    const row = controller!.rows[0];

    act(() => { controller?.requestDelete(row); });
    expect(controller?.confirmingDelete).toBe('claude:api');
    expect(adapter.remove).not.toHaveBeenCalled();
    act(() => { controller?.requestDelete(row); });
    await vi.waitFor(() => expect(controller?.removePending).toBe(true));
    expect(controller?.savePending).toBe(false);
    expect(adapter.remove).toHaveBeenCalledWith({ backend: 'claude', id: 'api' });

    gate.resolve({ removed: true });
    await vi.waitFor(() => expect(controller?.removePending).toBe(false));
    expect(controller?.confirmingDelete).toBeNull();
    expect(mounted.invalidate.mock.calls.map(call => call[0])).toEqual(REFRESHES);
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('keeps draft/confirmation state and reports failure toasts without refreshes', async () => {
    adapter.upsert.mockRejectedValue(new Error('save denied'));
    adapter.remove.mockRejectedValue(new Error('remove denied'));
    const mounted = await mount();
    const row = controller!.rows[1];
    act(() => { controller?.openEdit(row); });
    act(() => { controller?.save(); });
    await vi.waitFor(() => expect(adapter.toast).toHaveBeenCalledTimes(1));
    expect(controller?.draft?.name).toBe('my-vllm');

    act(() => { controller?.requestDelete(row); });
    act(() => { controller?.requestDelete(row); });
    await vi.waitFor(() => expect(adapter.toast).toHaveBeenCalledTimes(2));
    expect(controller?.confirmingDelete).toBe('pi:my-vllm');
    expect(mounted.invalidate).not.toHaveBeenCalled();
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('offers no override kind once every PI provider has a connection', async () => {
    adapter.status.mockResolvedValue({ accounts: [{ backend: 'pi', provider: 'my-vllm' }] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryClientProvider client={queryClient}><LangProvider><Probe /></LangProvider></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(controller?.rows).toHaveLength(2));
    expect(controller?.kinds).toEqual(['claude', 'pi-custom']);
    renderer.unmount();
    queryClient.clear();
  });
});
