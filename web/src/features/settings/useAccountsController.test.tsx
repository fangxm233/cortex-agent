// input:  mounted accounts controller, auth adapters, query cache, and localized toast spy
// output: status, logout, rescan, invalidation, feedback, and pending-state regressions
// pos:    Shared desktop/mobile accounts controller integration specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { useAccountsController, type AccountsController } from './useAccountsController';

const STATUS: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

const adapter = vi.hoisted(() => ({
  status: vi.fn(),
  logout: vi.fn(),
  syncGateway: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    auth: {
      status: {
        queryOptions: (input: unknown) => ({
          queryKey: ['auth.status', input], queryFn: () => adapter.status(input),
        }),
        queryFilter: (input: unknown) => ({ queryKey: ['auth.status', input] }),
      },
      logout: {
        mutationOptions: (options: object) => ({
          ...options, mutationFn: (input: unknown) => adapter.logout(input),
        }),
      },
      syncGateway: {
        mutationOptions: (options: object) => ({
          ...options, mutationFn: (input: unknown) => adapter.syncGateway(input),
        }),
      },
    },
    config: {
      get: { queryFilter: (input: unknown) => ({ queryKey: ['config.get', input] }) },
    },
  }),
}));

vi.mock('@/design', () => ({
  useToast: () => ({ toast: adapter.toast }),
}));

let controller: AccountsController | null = null;

function Probe() {
  controller = useAccountsController();
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
  await vi.waitFor(() => expect(controller?.statusLoading).toBe(false));
  return { queryClient, invalidate, renderer };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  controller = null;
  vi.clearAllMocks();
  adapter.status.mockResolvedValue(STATUS);
  adapter.logout.mockResolvedValue({});
  adapter.syncGateway.mockResolvedValue({ configured: true });
});

describe('useAccountsController', () => {
  it('loads auth.status and exposes its secret-free snapshot', async () => {
    const mounted = await mount();

    expect(adapter.status).toHaveBeenCalledWith({});
    expect(controller?.status).toEqual(STATUS);
    expect(controller?.statusError).toBeNull();
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('logs out the exact target with a logout-local pending gate, refresh, and toast', async () => {
    const gate = deferred<unknown>();
    adapter.logout.mockReturnValue(gate.promise);
    const mounted = await mount();
    const target = { backend: 'pi' as const, provider: 'openrouter', authType: 'oauth' as const };

    act(() => { controller?.logout(target); });
    await vi.waitFor(() => expect(controller?.logoutPending).toBe(true));
    expect(controller?.syncPending).toBe(false);
    expect(adapter.logout).toHaveBeenCalledWith(target);

    gate.resolve({});
    await vi.waitFor(() => expect(controller?.logoutPending).toBe(false));
    expect(mounted.invalidate).toHaveBeenCalledTimes(1);
    expect(mounted.invalidate).toHaveBeenCalledWith({ queryKey: ['auth.status', {}] });
    expect(adapter.toast).toHaveBeenCalledWith({ title: en.accountsLogoutDone, tone: 'done' });
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('rescans independently and invalidates status plus config only when models were configured', async () => {
    adapter.syncGateway.mockResolvedValueOnce({ configured: false });
    const empty = await mount();

    act(() => { controller?.syncGateway(); });
    await vi.waitFor(() => expect(adapter.toast).toHaveBeenCalledWith({
      title: en.accountsSyncModelsEmpty, tone: 'waiting',
    }));
    expect(adapter.syncGateway).toHaveBeenCalledWith({});
    expect(empty.invalidate).not.toHaveBeenCalled();
    empty.renderer.unmount();
    empty.queryClient.clear();

    vi.clearAllMocks();
    adapter.status.mockResolvedValue(STATUS);
    const gate = deferred<{ configured: boolean }>();
    adapter.syncGateway.mockReturnValue(gate.promise);
    const configured = await mount();
    act(() => { controller?.syncGateway(); });
    await vi.waitFor(() => expect(controller?.syncPending).toBe(true));
    expect(controller?.logoutPending).toBe(false);
    gate.resolve({ configured: true });
    await vi.waitFor(() => expect(controller?.syncPending).toBe(false));

    expect(configured.invalidate.mock.calls.map(call => call[0])).toEqual([
      { queryKey: ['auth.status', {}] },
      { queryKey: ['config.get', {}] },
    ]);
    expect(adapter.toast).toHaveBeenCalledWith({ title: en.accountsSyncModelsDone, tone: 'done' });
    configured.renderer.unmount();
    configured.queryClient.clear();
  });

  it('reports operation-specific failures without invalidating successful snapshots', async () => {
    adapter.logout.mockRejectedValue(new Error('logout denied'));
    adapter.syncGateway.mockRejectedValue(new Error('scan denied'));
    const mounted = await mount();

    act(() => {
      controller?.logout({ backend: 'claude', provider: 'anthropic', authType: 'api_key' });
      controller?.syncGateway();
    });
    await vi.waitFor(() => expect(adapter.toast).toHaveBeenCalledTimes(2));

    expect(adapter.toast.mock.calls.map(call => call[0])).toEqual([
      { title: `${en.accountsLogoutFailed}: logout denied`, tone: 'failed' },
      { title: `${en.accountsSyncModelsFailed}: scan denied`, tone: 'failed' },
    ]);
    expect(mounted.invalidate).not.toHaveBeenCalled();
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });
});
