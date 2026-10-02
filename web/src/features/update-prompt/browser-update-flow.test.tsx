import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemUpdateStatus } from '@cortex-agent/ui-contract';
import type { ToastInput } from '@/design/Toast';
import { useManualUpdateCheck } from './useManualUpdateCheck';
import { useUpdatePrompt, type UpdatePrompt } from './useUpdatePrompt';

const api = vi.hoisted(() => ({
  status: { state: 'prompting', available: '2026.10.1' } as SystemUpdateStatus,
  check: vi.fn(), apply: vi.fn(), skip: vi.fn(), read: vi.fn(), page: vi.fn(),
  toast: vi.fn((_input: ToastInput) => 'progress'), dismiss: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPCClient: () => ({ system: { checkUpdate: { mutate: api.check } } }),
  useTRPC: () => ({ system: {
    updateStatus: {
      queryKey: () => ['updateStatus'], queryFilter: () => ({ queryKey: ['updateStatus'] }),
      queryOptions: () => ({ queryKey: ['updateStatus'], queryFn: api.read }),
    },
    applyUpdate: { mutationOptions: (options: object) => ({ mutationFn: api.apply, ...options }) },
    skipUpdate: { mutationOptions: (options: object) => ({ mutationFn: api.skip, ...options }) },
  } }),
}));
vi.mock('@/features/hot-update/browser-update', async (original) => ({
  ...await original<object>(), checkBrowserUpdate: api.page,
}));
vi.mock('@/i18n', async () => {
  const { en } = await import('@/i18n/vocab');
  return { useVocab: () => en };
});
vi.mock('@/design/Toast', () => ({ useToastOptional: () => ({ toast: api.toast, dismiss: api.dismiss }) }));

let prompt: UpdatePrompt;
let manual: ReturnType<typeof useManualUpdateCheck>;
let renderer: ReactTestRenderer;
let queryClient: QueryClient;
const invoke = vi.fn();
function Probe() { manual = useManualUpdateCheck(); prompt = useUpdatePrompt(); return null; }
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
beforeEach(async () => {
  vi.clearAllMocks();
  api.status = { state: 'prompting', available: '2026.10.1' };
  api.read.mockImplementation(async () => api.status);
  api.check.mockResolvedValue({ status: 'available', update: { version: '2026.10.1' } });
  api.page.mockResolvedValue({ status: 'available', update: { kind: 'browser-page' } });
  vi.stubGlobal('__CORTEX_DESKTOP__', false);
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  vi.stubGlobal('location', { reload: vi.fn() });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
    await tick();
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  queryClient.clear();
  vi.unstubAllGlobals();
});

async function status(state: SystemUpdateStatus['state']) {
  api.status = { state, available: state === 'idle' ? null : '2026.10.1' };
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ['updateStatus'] }); await tick(); });
}

describe('browser/server update integration', () => {
  it('reopens Later, refreshes status, keeps server first and applies nothing during discovery', async () => {
    expect(prompt?.kind).toBe('server');
    act(() => prompt?.dismiss());
    expect(prompt).toBeNull();
    const reads = api.read.mock.calls.length;
    await act(async () => { await manual.check(); await tick(); });
    expect(api.check.mock.calls).toEqual([[{}]]);
    expect(api.read.mock.calls.length).toBeGreaterThan(reads);
    expect(prompt?.kind).toBe('server');
    expect(api.apply).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();
    expect(api.toast.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ title: 'Server update', description: 'Update ready for confirmation.' })],
    ]));
    expect(api.toast.mock.calls.flat().some((input) => input.title === 'App update')).toBe(false);
  });

  it('rechecks only page assets after installing → idle and reloads only with consent', async () => {
    await act(async () => { await manual.check(); await tick(); });
    await status('installing');
    await status('idle');
    expect(api.page).toHaveBeenCalledTimes(2);
    expect(api.check).toHaveBeenCalledOnce();
    expect(prompt?.kind).toBe('page');
    expect(location.reload).not.toHaveBeenCalled();
    act(() => prompt?.dismiss());
    expect(prompt).toBeNull();
    api.check.mockResolvedValue({ status: 'current' });
    await act(async () => { await manual.check(); await tick(); });
    expect(prompt?.kind).toBe('page');
    act(() => { if (prompt?.kind === 'page') prompt.apply(); });
    expect(location.reload).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports a server discovery failure without claiming that channel is current', async () => {
    await status('idle');
    api.check.mockRejectedValue(new Error('private hostname'));
    api.page.mockResolvedValue({ status: 'current' });
    await act(async () => { await manual.check(); await tick(); });
    expect(prompt).toBeNull();
    expect(api.toast.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ title: 'Server update', tone: 'failed' })],
      [expect.objectContaining({ title: 'UI update', description: 'Up to date.' })],
    ]));
  });
});
