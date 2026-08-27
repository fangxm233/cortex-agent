// input:  shared runtime writer, typed setting keys and mutation/cache fakes
// output: commit lifecycle, serialization, refresh and production-adapter regressions
// pos:    Verifies the desktop/mobile-neutral runtime settings write owner
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const adapter = vi.hoisted(() => ({
  set: vi.fn(),
  mutationOptions: vi.fn(),
  queryFilter: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    config: {
      set: { mutationOptions: adapter.mutationOptions },
      get: { queryFilter: adapter.queryFilter },
    },
  }),
}));

vi.mock('@/design', () => ({
  useToast: () => ({ toast: adapter.toast }),
}));

import {
  commitSettingToggle,
  commitSettingValue,
  useRuntimeSettingWrite,
  type RuntimeSettingWriter,
  type WritableBooleanSettingKey,
} from './runtime-settings-writer';

function captureWriter(queryClient: QueryClient): RuntimeSettingWriter {
  let writer: RuntimeSettingWriter | undefined;
  function Harness() {
    writer = useRuntimeSettingWrite();
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <LangProvider><Harness /></LangProvider>
    </QueryClientProvider>,
  );
  return writer!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('runtime setting commits', () => {
  it.each<[WritableBooleanSettingKey, boolean]>([
    ['turnNotify', true],
    ['autoResume', false],
    ['notifyCompaction', true],
    ['eventLog', false],
    ['diskMonitor', false],
    ['showToolCalls', true],
    ['disableUserContext', false],
    ['serverUpdateDisable', true],
    ['taskDispatchEnabled', true],
    ['taskArchiveEnabled', false],
    ['memoryIndexRegenEnabled', false],
  ])('writes %s through config.set settings and refreshes the snapshot', async (key, nextValue) => {
    const set = vi.fn().mockResolvedValue({ written: true, section: 'settings' });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    await commitSettingToggle({ set, refresh, onError }, key, nextValue);

    expect(set).toHaveBeenCalledWith({ section: 'settings', value: { [key]: nextValue } });
    expect(refresh).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['taskArchiveIntervalMs', 3_600_000],
    ['sessionRetentionDays', 45],
  ] as const)('writes the validated %s number through the generic path', async (key, nextValue) => {
    const set = vi.fn().mockResolvedValue({ written: true, section: 'settings' });
    const refresh = vi.fn().mockResolvedValue(undefined);

    await commitSettingValue({ set, refresh, onError: vi.fn() }, key, nextValue);

    expect(set).toHaveBeenCalledWith({ section: 'settings', value: { [key]: nextValue } });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reports a failed write, skips refresh, and does not mutate caller state', async () => {
    const state = { eventLog: true };
    const before = structuredClone(state);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    await commitSettingToggle(
      { set: vi.fn().mockRejectedValue(new Error('denied')), refresh, onError },
      'eventLog',
      false,
    );

    expect(refresh).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('denied');
    expect(state).toEqual(before);
  });

  it('reports a failed snapshot refresh instead of leaving an unhandled rejection', async () => {
    const onError = vi.fn();

    await commitSettingToggle({
      set: vi.fn().mockResolvedValue({ written: true, section: 'settings' }),
      refresh: vi.fn().mockRejectedValue(new Error('refresh denied')),
      onError,
    }, 'turnNotify', true);

    expect(onError).toHaveBeenCalledWith('refresh denied');
  });

  it('keeps the write pending until the refreshed snapshot arrives', async () => {
    const onPending = vi.fn();
    let releaseRefresh = () => {};
    const deps = {
      set: vi.fn().mockResolvedValue({ written: true, section: 'settings' }),
      refresh: vi.fn(() => new Promise<void>((resolve) => { releaseRefresh = resolve; })),
      onError: vi.fn(),
      onPending,
    };

    const commit = commitSettingToggle(deps, 'autoResume', false);
    await Promise.resolve();
    expect(onPending.mock.calls).toEqual([[true]]);

    releaseRefresh();
    await commit;
    expect(onPending.mock.calls).toEqual([[true], [false]]);
  });
});

describe('runtime setting production adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.mutationOptions.mockReturnValue({ mutationFn: adapter.set });
    adapter.queryFilter.mockImplementation((input) => ({ queryKey: ['config.get', input] }));
  });

  it('binds config.set and suppresses repeat clicks until refresh completes', async () => {
    const setGate = deferred<unknown>();
    const refreshGate = deferred<void>();
    adapter.set.mockReturnValue(setGate.promise);
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockReturnValue(refreshGate.promise);
    const writer = captureWriter(queryClient);

    writer.onToggle('turnNotify', true);
    writer.onToggle('turnNotify', true);
    await vi.waitFor(() => expect(adapter.set).toHaveBeenCalled());
    setGate.resolve({ written: true, section: 'settings' });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    writer.onToggle('turnNotify', true);
    await Promise.resolve();
    expect(adapter.set).toHaveBeenCalledOnce();

    refreshGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    writer.onToggle('autoResume', false);
    await vi.waitFor(() => expect(adapter.set).toHaveBeenCalledTimes(2));

    expect(adapter.mutationOptions).toHaveBeenCalledOnce();
    expect(adapter.set).toHaveBeenNthCalledWith(1,
      { section: 'settings', value: { turnNotify: true } }, expect.anything());
    expect(adapter.queryFilter).toHaveBeenNthCalledWith(1, {});
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ['config.get', {}] });
    queryClient.clear();
  });

  it('surfaces the localized production toast and skips refresh when config.set rejects', async () => {
    adapter.set.mockRejectedValue(new Error('denied'));
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const writer = captureWriter(queryClient);

    writer.onToggle('eventLog', false);
    await vi.waitFor(() => expect(adapter.toast).toHaveBeenCalled());

    expect(adapter.set).toHaveBeenCalledWith(
      { section: 'settings', value: { eventLog: false } },
      expect.anything(),
    );
    expect(adapter.queryFilter).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(adapter.toast).toHaveBeenCalledWith({ title: 'Write failed: denied', tone: 'failed' });
    queryClient.clear();
  });
});
