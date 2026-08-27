// input:  mounted profiles controller, config/profile adapters, query cache and toast spy
// output: facts, editor, validation, writes, confirmation and operation-local pending regressions
// pos:    Shared desktop/mobile profiles controller integration specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConfigProfileEntry, ConfigSnapshot } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { useProfilesController, type ProfilesController } from './useProfilesController';

function entry(over: Partial<ConfigProfileEntry> = {}): ConfigProfileEntry {
  return {
    name: 'plan', model: 'claude-opus-5', backend: 'claude', mode: 'plan', thinking: 'max',
    provider: null, claudeBackend: null, extraOption: {}, extraEnvKeys: [], fallbackCount: 0,
    ...over,
  };
}

const SOL = entry({
  name: 'sol', model: 'gpt-5', backend: 'pi', mode: 'openai', provider: 'openai', thinking: 'high',
});
const SNAPSHOT = {
  budget: null, profiles: { defaultProfile: 'plan', profiles: [entry(), SOL] }, machines: [],
  mcp: null, threadTemplates: { agents: [], templates: [], shells: [] }, hooks: [], env: [], settings: [],
} as unknown as ConfigSnapshot;

const adapter = vi.hoisted(() => ({
  config: vi.fn(), set: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toast: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    config: {
      get: {
        queryOptions: (input: unknown) => ({ queryKey: ['config.get', input], queryFn: () => adapter.config(input) }),
        queryFilter: (input: unknown) => ({ queryKey: ['config.get', input] }),
      },
      set: { mutationOptions: (options: object) => ({
        ...options, mutationFn: (input: unknown) => adapter.set(input),
      }) },
    },
    profiles: {
      create: { mutationOptions: (options: object) => ({
        ...options, mutationFn: (input: unknown) => adapter.create(input),
      }) },
      update: { mutationOptions: (options: object) => ({
        ...options, mutationFn: (input: unknown) => adapter.update(input),
      }) },
      remove: { mutationOptions: (options: object) => ({
        ...options, mutationFn: (input: unknown) => adapter.remove(input),
      }) },
    },
  }),
}));

vi.mock('@/design', () => ({ useToast: () => ({ toast: adapter.toast }) }));

let controller: ProfilesController | null = null;

function Probe() {
  controller = useProfilesController();
  return null;
}

async function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<QueryClientProvider client={queryClient}>
      <LangProvider><Probe /></LangProvider>
    </QueryClientProvider>);
  });
  await vi.waitFor(() => expect(controller?.loading).toBe(false));
  return { queryClient, invalidate, renderer };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function validCreate() {
  return {
    name: 'new-pi', model: 'deepseek-v3', backend: 'pi' as const, mode: 'openai',
    provider: 'deepseek', thinking: 'high', claudeBackend: '' as const, extraOption: [],
  };
}

beforeEach(() => {
  controller = null;
  vi.clearAllMocks();
  adapter.config.mockResolvedValue(SNAPSHOT);
  adapter.set.mockResolvedValue({ section: 'profiles', written: true });
  adapter.create.mockResolvedValue({ name: 'new-pi' });
  adapter.update.mockResolvedValue({ changed: true });
  adapter.remove.mockResolvedValue({ removed: true });
});

describe('useProfilesController', () => {
  it('loads config facts and owns create/edit drafts, backend transitions and validation', async () => {
    const mounted = await mount();
    expect(adapter.config).toHaveBeenCalledWith({});
    expect(controller?.defaultProfile).toBe('plan');
    expect(controller?.profileFacts.map(fact => ({
      name: fact.profile.name, current: fact.current, canDefault: fact.canSetDefault, canDelete: fact.canDelete,
    }))).toEqual([
      { name: 'plan', current: true, canDefault: false, canDelete: false },
      { name: 'sol', current: false, canDefault: true, canDelete: true },
    ]);

    act(() => { controller?.openCreate(); });
    expect(controller?.creating).toBe(true);
    expect(controller?.errors).toMatchObject({ name: 'name-required', model: 'model-required' });
    act(() => { controller?.changeDraft({ ...validCreate(), backend: 'claude', thinking: 'max', provider: '' }); });
    act(() => { controller?.changeBackend('pi'); });
    expect(controller?.draft).toMatchObject({ backend: 'pi', thinking: '' });
    expect(controller?.errors.provider).toBe('provider-required');

    act(() => { controller?.openEdit('sol'); });
    expect(controller?.creating).toBe(false);
    expect(controller?.draft).toMatchObject({ name: 'sol', model: 'gpt-5', provider: 'openai' });
    expect(controller?.dirty).toBe(false);
    act(() => { controller?.changeDraft({ ...controller!.draft!, model: 'gpt-5.1' }); });
    expect(controller?.dirty).toBe(true);
    act(() => { controller?.revertDraft(); });
    expect(controller?.draft?.model).toBe('gpt-5');
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('creates while a default write is pending and gives each operation exact refresh and feedback', async () => {
    const setGate = deferred<{ section: 'profiles'; written: true }>();
    adapter.set.mockReturnValue(setGate.promise);
    const mounted = await mount();

    act(() => { controller?.setDefault('sol'); });
    await vi.waitFor(() => expect(controller?.defaultPendingName).toBe('sol'));
    expect(controller?.savePending).toBe(false);
    act(() => { controller?.openCreate(); });
    act(() => { controller?.changeDraft(validCreate()); });
    act(() => { controller?.save(); });
    await vi.waitFor(() => expect(adapter.create).toHaveBeenCalledWith({
      name: 'new-pi', model: 'deepseek-v3', backend: 'pi', mode: 'openai',
      provider: 'deepseek', thinking: 'high',
    }));
    await vi.waitFor(() => expect(controller?.draft).toBeNull());
    expect(controller?.defaultPendingName).toBe('sol');
    expect(adapter.toast).toHaveBeenCalledWith({ title: `${en.pfToastCreated} · new-pi`, tone: 'done' });

    setGate.resolve({ section: 'profiles', written: true });
    await vi.waitFor(() => expect(controller?.defaultPendingName).toBeNull());
    expect(mounted.invalidate.mock.calls.map(call => call[0])).toEqual([
      { queryKey: ['config.get', {}] }, { queryKey: ['config.get', {}] },
    ]);
    expect(adapter.toast).toHaveBeenCalledWith({
      title: `${en.stDefaultProfile} → sol · ${en.stToastDefaultProfile}`, tone: 'done',
    });
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('updates through canonical args and reports unchanged writes distinctly', async () => {
    adapter.update.mockResolvedValue({ changed: false });
    const mounted = await mount();
    act(() => { controller?.openEdit('sol'); });
    act(() => { controller?.changeDraft({ ...controller!.draft!, model: 'gpt-5.1' }); });
    act(() => { controller?.save(); });

    await vi.waitFor(() => expect(adapter.update).toHaveBeenCalledWith({
      name: 'sol', model: 'gpt-5.1', backend: 'pi', mode: 'openai',
      provider: 'openai', thinking: 'high',
    }));
    await vi.waitFor(() => expect(controller?.draft).toBeNull());
    expect(mounted.invalidate).toHaveBeenCalledWith({ queryKey: ['config.get', {}] });
    expect(adapter.toast).toHaveBeenCalledWith({ title: en.pfToastUnchanged, tone: 'done' });
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });

  it('guards default deletion, owns confirmation, and isolates remove pending and failure feedback', async () => {
    const removeGate = deferred<{ removed: boolean }>();
    adapter.remove.mockReturnValue(removeGate.promise);
    const mounted = await mount();
    act(() => { controller?.requestDelete('plan'); });
    expect(controller?.confirmingDelete).toBeNull();
    act(() => { controller?.requestDelete('sol'); });
    expect(controller?.confirmingDelete).toBe('sol');
    act(() => { controller?.confirmDelete('sol'); });
    await vi.waitFor(() => expect(controller?.removePendingName).toBe('sol'));
    expect(controller?.savePending).toBe(false);
    expect(controller?.defaultPendingName).toBeNull();

    removeGate.reject(new Error('remove denied'));
    await vi.waitFor(() => expect(controller?.removePendingName).toBeNull());
    expect(controller?.confirmingDelete).toBeNull();
    expect(mounted.invalidate).not.toHaveBeenCalled();
    expect(adapter.toast).toHaveBeenCalledWith({
      title: `${en.pfToastWriteFailed}: remove denied`, tone: 'failed',
    });
    mounted.renderer.unmount();
    mounted.queryClient.clear();
  });
});
