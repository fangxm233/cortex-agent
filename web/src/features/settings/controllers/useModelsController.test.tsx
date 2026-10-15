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
const adapter = vi.hoisted(() => ({ config: vi.fn(), catalog: vi.fn(), add: vi.fn(), remove: vi.fn(), setDefault: vi.fn(), setThinking: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/trpc', () => {
  const mutation = (fn: (input: unknown) => unknown) => ({ mutationOptions: (options: object) => ({ ...options, mutationFn: (input: unknown) => fn(input) }) });
  return { useTRPC: () => ({
    config: { get: { queryOptions: () => ({ queryKey: ['config'], queryFn: adapter.config }), queryFilter: () => ({ queryKey: ['config'] }) } },
    models: { catalog: { queryOptions: () => ({ queryKey: ['catalog'], queryFn: adapter.catalog }) },
      favorites: { add: mutation(adapter.add), remove: mutation(adapter.remove) }, setDefault: mutation(adapter.setDefault), setThinking: mutation(adapter.setThinking) },
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
  adapter.setThinking.mockResolvedValue({ changed: true });
});

describe('favorite thinking writes', () => {
  it.each(['high', 'off', null])('writes only the ref and thinking (%s), then refreshes config', async thinking => {
    const { view, invalidate } = await mount();
    const target = thinking === 'off' ? other : ref;
    await act(async () => controller.setThinking(target, thinking));
    expect(adapter.setThinking).toHaveBeenCalledWith({ ref: target, thinking });
    expect(adapter.setDefault).not.toHaveBeenCalled();
    expect(adapter.add).not.toHaveBeenCalled();
    expect(adapter.remove).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['config'] });
    expect(adapter.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'done' }));
    act(() => view.unmount());
  });
  it('disables writes while pending and retains memory on failure without a success toast', async () => {
    let reject!: (error: Error) => void;
    adapter.setThinking.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const { view, invalidate } = await mount();
    await act(async () => { controller.setThinking(ref, null); controller.remove(other); });
    expect(controller.pending).toBe(true);
    expect(controller.facts[0].thinking).toBe('max');
    expect(adapter.remove).not.toHaveBeenCalled();
    await act(async () => reject(new Error('denied')));
    expect(controller.pending).toBe(false);
    expect(controller.facts[0].thinking).toBe('max');
    expect(invalidate).not.toHaveBeenCalled();
    expect(adapter.toast).toHaveBeenCalledOnce();
    expect(adapter.toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('denied'), tone: 'failed' }));
    act(() => view.unmount());
  });
});

describe('thinking catalog availability', () => {
  it('exposes no capabilities until the catalog has loaded, preserving memory', async () => {
    adapter.catalog.mockReturnValueOnce(new Promise(() => {}));
    const { view } = await mount();
    expect(controller.catalog).toBeNull();
    expect(controller.catalogPending).toBe(true);
    expect(controller.facts[0].thinking).toBe('max');
    expect(adapter.setThinking).not.toHaveBeenCalled();
    act(() => view.unmount());
  });
  it('exposes no capabilities on catalog failure, preserving memory', async () => {
    adapter.catalog.mockRejectedValueOnce(new Error('catalog unavailable'));
    const { view } = await mount();
    await vi.waitFor(() => expect(controller.catalogError?.message).toBe('catalog unavailable'));
    expect(controller.catalog).toBeNull();
    expect(controller.facts[0].thinking).toBe('max');
    expect(adapter.setThinking).not.toHaveBeenCalled();
    act(() => view.unmount());
  });
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
