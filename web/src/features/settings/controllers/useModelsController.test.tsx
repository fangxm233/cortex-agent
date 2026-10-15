import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConfigSnapshot, ModelRef } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { modelKey } from '@/lib/model-selection';
import { useModelsController, type ModelsController } from './useModelsController';

const ref: ModelRef = { backend: 'claude', provider: null, model: 'opus' };
const other: ModelRef = { backend: 'pi', provider: 'deepseek', model: 'flash' };
const snapshot = { models: { default: { ...ref, mode: 'plan', thinking: 'high' }, favorites: [ref, other],
  memory: { [modelKey(ref)]: { mode: 'api', thinking: 'max' } } } } as ConfigSnapshot;
const catalog = { routes: [{ endpoint: 'deepseek', backend: 'pi', provider: 'deepseek',
  modes: ['deepseek'], models: ['flash', 'new-model'], source: 'pi' }], piPending: false };
const adapter = vi.hoisted(() => ({ config: vi.fn(), catalog: vi.fn(), add: vi.fn(), remove: vi.fn(), setDefault: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/trpc', () => {
  const mutation = (fn: (input: unknown) => unknown) => ({ mutationOptions: (options: object) => ({ ...options, mutationFn: (input: unknown) => fn(input) }) });
  return { useTRPC: () => ({
    config: { get: { queryOptions: () => ({ queryKey: ['config'], queryFn: adapter.config }), queryFilter: () => ({ queryKey: ['config'] }) } },
    models: { catalog: { queryOptions: () => ({ queryKey: ['catalog'], queryFn: adapter.catalog }) },
      favorites: { add: mutation(adapter.add), remove: mutation(adapter.remove) }, setDefault: mutation(adapter.setDefault) },
  }) };
});
vi.mock('@/design', () => ({ useToast: () => ({ toast: adapter.toast }) }));
let controller: ModelsController;
function Probe() { controller = useModelsController(); return null; }
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<QueryClientProvider client={client}><LangProvider><Probe /></LangProvider></QueryClientProvider>); });
  await vi.waitFor(() => expect(controller.loading).toBe(false));
  return { view, invalidate };
}
beforeEach(() => {
  vi.clearAllMocks();
  adapter.config.mockResolvedValue(snapshot); adapter.catalog.mockResolvedValue(catalog);
  adapter.add.mockResolvedValue({ changed: true }); adapter.remove.mockResolvedValue({ changed: true });
  adapter.setDefault.mockResolvedValue({ changed: true });
});

describe('model settings writes', () => {
  it('loads catalog choices for the default picker without opening the favorites editor', async () => {
    const { view } = await mount();
    expect(controller.facts).toHaveLength(2);
    await vi.waitFor(() => expect(controller.options).toContainEqual({ ...other, model: 'new-model' }));
    expect(adapter.catalog).toHaveBeenCalledOnce();
    expect(controller.catalogOpen).toBe(false);
    act(() => view.unmount());
  });
  it('writes a complete selection using memory and refreshes config', async () => {
    const { view, invalidate } = await mount();
    await act(async () => controller.setDefault(modelKey(ref)));
    expect(adapter.setDefault).toHaveBeenCalledWith({ selection: { ...ref, mode: 'api', thinking: 'max' } });
    expect(invalidate).toHaveBeenCalled();
    act(() => view.unmount());
  });
  it('resolves a first-time model route from the catalog before setting default', async () => {
    const { view } = await mount();
    await act(async () => controller.setDefault(modelKey(other)));
    expect(adapter.catalog).toHaveBeenCalledOnce();
    expect(adapter.setDefault).toHaveBeenCalledWith({ selection: { ...other, thinking: null, mode: 'deepseek' } });
    act(() => view.unmount());
  });
  it('allows removing the default or last favorite without changing the default', async () => {
    const { view, invalidate } = await mount();
    await act(async () => controller.remove(ref));
    expect(adapter.remove).toHaveBeenCalledWith({ ...ref, provider: undefined });
    expect(adapter.setDefault).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
    act(() => view.unmount());
  });
  it('serializes same-tick writes and reports errors without refreshing config', async () => {
    const { view, invalidate } = await mount();
    adapter.add.mockRejectedValueOnce(new Error('denied'));
    await act(async () => { controller.add(other); controller.remove(ref); });
    expect(adapter.add).toHaveBeenCalledOnce();
    expect(adapter.remove).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(adapter.toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('denied'), tone: 'failed' }));
    act(() => view.unmount());
  });
});
