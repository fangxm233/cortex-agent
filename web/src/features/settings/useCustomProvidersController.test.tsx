// input:  mounted custom-provider controller, auth adapters, query cache, and toast spy
// output: list, draft, validation, save, two-step remove, and independent pending regressions
// pos:    Shared desktop/mobile custom-provider controller integration specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CustomProviderView } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import {
  useCustomProvidersController,
  type CustomProvidersController,
} from './useCustomProvidersController';

const PROVIDER: CustomProviderView = {
  name: 'my-vllm',
  api: 'anthropic-messages',
  models: [{ id: 'Model-27B' }],
  upstreamUrl: 'http://127.0.0.1:8100',
  hasApiKey: true,
  routed: true,
};

const adapter = vi.hoisted(() => ({
  list: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    auth: {
      customProviders: {
        queryOptions: (input: unknown) => ({
          queryKey: ['auth.customProviders', input], queryFn: () => adapter.list(input),
        }),
        queryFilter: (input: unknown) => ({ queryKey: ['auth.customProviders', input] }),
      },
      status: { queryFilter: (input: unknown) => ({ queryKey: ['auth.status', input] }) },
      upsertCustomProvider: {
        mutationOptions: (options: object) => ({
          ...options, mutationFn: (input: unknown) => adapter.upsert(input),
        }),
      },
      removeCustomProvider: {
        mutationOptions: (options: object) => ({
          ...options, mutationFn: (input: unknown) => adapter.remove(input),
        }),
      },
    },
  }),
}));

vi.mock('@/design', () => ({
  useToast: () => ({ toast: adapter.toast }),
}));

let controller: CustomProvidersController | null = null;

function Probe() {
  controller = useCustomProvidersController();
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
  await vi.waitFor(() => expect(controller?.listLoading).toBe(false));
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
  adapter.list.mockResolvedValue([PROVIDER]);
  adapter.upsert.mockResolvedValue({});
  adapter.remove.mockResolvedValue({ removed: true });
});

describe('useCustomProvidersController', () => {
  it('loads the list and derives create/edit drafts with canonical validation', async () => {
    const mounted = await mount();
    expect(adapter.list).toHaveBeenCalledWith({});
    expect(controller?.providers).toEqual([PROVIDER]);

    act(() => { controller?.openCreate(); });
    expect(controller?.creating).toBe(true);
    expect(controller?.errors).toEqual({
      name: 'name-required', upstreamUrl: 'upstream-required', models: 'models-required',
    });
    act(() => { controller?.changeDraft({
      name: 'my-vllm', api: 'anthropic-messages', upstreamUrl: 'http://localhost:8100',
      apiKey: '', models: 'Model-27B',
    }); });
    expect(controller?.errors.name).toBe('name-taken');
    act(() => { controller?.save(); });
    expect(adapter.upsert).not.toHaveBeenCalled();

    act(() => { controller?.openEdit(PROVIDER); });
    expect(controller?.creating).toBe(false);
    expect(controller?.draft).toMatchObject({
      name: 'my-vllm', upstreamUrl: 'http://127.0.0.1:8100', apiKey: '', models: 'Model-27B',
    });
    expect(controller?.errors).toEqual({});
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('saves a valid draft with save-local pending, exact refreshes, close, and toast', async () => {
    const gate = deferred<unknown>();
    adapter.upsert.mockReturnValue(gate.promise);
    const mounted = await mount();
    act(() => {
      controller?.openCreate();
      controller?.changeDraft({
        name: 'my-proxy', api: 'openai-completions', upstreamUrl: 'https://proxy.example/v1',
        apiKey: ' secret ', models: 'small\nlarge',
      });
    });

    act(() => { controller?.save(); });
    await vi.waitFor(() => expect(controller?.savePending).toBe(true));
    expect(controller?.removePending).toBe(false);
    expect(adapter.upsert).toHaveBeenCalledWith({
      name: 'my-proxy', api: 'openai-completions', upstreamUrl: 'https://proxy.example/v1',
      apiKey: 'secret', models: [{ id: 'small' }, { id: 'large' }],
    });

    gate.resolve({});
    await vi.waitFor(() => expect(controller?.savePending).toBe(false));
    expect(controller?.draft).toBeNull();
    expect(mounted.invalidate.mock.calls.map(call => call[0])).toEqual([
      { queryKey: ['auth.customProviders', {}] },
      { queryKey: ['auth.status', {}] },
    ]);
    expect(adapter.toast).toHaveBeenCalledWith({ title: en.cpvToastSaved, tone: 'done' });
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('removes only on the second request with remove-local pending and exact success effects', async () => {
    const gate = deferred<{ removed: boolean }>();
    adapter.remove.mockReturnValue(gate.promise);
    const mounted = await mount();

    act(() => { controller?.requestDelete('my-vllm'); });
    expect(controller?.confirmingDelete).toBe('my-vllm');
    expect(adapter.remove).not.toHaveBeenCalled();
    act(() => { controller?.requestDelete('my-vllm'); });
    await vi.waitFor(() => expect(controller?.removePending).toBe(true));
    expect(controller?.savePending).toBe(false);
    expect(adapter.remove).toHaveBeenCalledWith({ name: 'my-vllm' });

    gate.resolve({ removed: true });
    await vi.waitFor(() => expect(controller?.removePending).toBe(false));
    expect(controller?.confirmingDelete).toBeNull();
    expect(mounted.invalidate.mock.calls.map(call => call[0])).toEqual([
      { queryKey: ['auth.customProviders', {}] },
      { queryKey: ['auth.status', {}] },
    ]);
    expect(adapter.toast).toHaveBeenCalledWith({ title: en.cpvToastDeleted, tone: 'done' });
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('keeps draft/confirmation state and reports exact failure toasts without refreshes', async () => {
    adapter.upsert.mockRejectedValue(new Error('save denied'));
    adapter.remove.mockRejectedValue(new Error('remove denied'));
    const mounted = await mount();
    act(() => { controller?.openEdit(PROVIDER); });
    act(() => { controller?.save(); });
    await vi.waitFor(() => expect(adapter.toast).toHaveBeenCalledTimes(1));
    expect(controller?.draft?.name).toBe('my-vllm');

    act(() => { controller?.requestDelete('my-vllm'); });
    act(() => { controller?.requestDelete('my-vllm'); });
    await vi.waitFor(() => expect(adapter.toast).toHaveBeenCalledTimes(2));
    expect(controller?.confirmingDelete).toBe('my-vllm');
    expect(adapter.toast.mock.calls.map(call => call[0])).toEqual([
      { title: `${en.cpvToastFailed}: save denied`, tone: 'failed' },
      { title: `${en.cpvToastFailed}: remove denied`, tone: 'failed' },
    ]);
    expect(mounted.invalidate).not.toHaveBeenCalled();
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });
});
