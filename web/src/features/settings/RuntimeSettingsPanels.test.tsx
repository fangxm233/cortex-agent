// input:  runtime settings panels, settings/env fixtures, mutation fakes
// output: settings-backed toggle and write-path regressions
// pos:    Verifies writable desktop Notifications and Advanced panels
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Children, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSnapshot, ConfigSettingEntry } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const adapter = vi.hoisted(() => ({
  set: vi.fn(),
  mutationOptions: vi.fn(),
  queryFilter: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trpc')>();
  return {
    ...actual,
    useTRPC: () => ({
      config: {
        set: { mutationOptions: adapter.mutationOptions },
        get: { queryFilter: adapter.queryFilter },
      },
    }),
  };
});

vi.mock('@/design', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/design')>();
  return { ...actual, useToast: () => ({ toast: adapter.toast }) };
});

import {
  AdvancedPanel,
  AdvancedPanelView,
  NotificationsPanel,
  NotificationsPanelView,
  RuntimeSettingToggleRow,
  commitSettingToggle,
  useRuntimeSettingWrite,
  type RuntimeSettingWriter,
  type WritableSettingKey,
} from './RuntimeSettingsPanels';

const settings: ConfigSettingEntry[] = [
  { key: 'turnNotify', value: false, source: 'file' },
  { key: 'turnNotifyThresholdS', value: 75, source: 'file' },
  { key: 'autoResume', value: true, source: 'default' },
  { key: 'notifyCompaction', value: false, source: 'file' },
  { key: 'eventLog', value: true, source: 'default' },
  { key: 'showToolCalls', value: false, source: 'file' },
  { key: 'disableUserContext', value: true, source: 'env' },
  { key: 'serverUpdateDisable', value: false, source: 'default' },
  { key: 'taskDispatchMaxConcurrent', value: 6, source: 'file' },
  { key: 'adminChannel', value: 'C0123', source: 'file' },
  { key: 'feishuAdminChannel', value: 'oc_456', source: 'file' },
];

const snapshot: ConfigSnapshot = {
  budget: null,
  profiles: null,
  machines: [],
  mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] },
  hooks: [],
  env: [
    { key: 'SLACK_BOT_TOKEN', present: true, masked: '••••••••' },
    { key: 'FEISHU_APP_ID', present: true, masked: '••••••••' },
    { key: 'CORTEX_TURN_NOTIFY', present: true, masked: '••••••••' },
    { key: 'CORTEX_EVENT_LOG', present: false, masked: '' },
    { key: 'DEBUG', present: true, masked: '••••••••' },
  ],
  settings,
};

function renderNotifications(value = snapshot): string {
  return renderToStaticMarkup(
    <LangProvider>
      <NotificationsPanelView snapshot={value} pending={false} onToggle={() => {}} />
    </LangProvider>,
  );
}

function renderAdvanced(value = snapshot): string {
  return renderToStaticMarkup(
    <LangProvider>
      <AdvancedPanelView snapshot={value} pending={false} onToggle={() => {}} />
    </LangProvider>,
  );
}

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

describe('runtime settings panel reads', () => {
  it('renders Notifications from settings even when legacy env presence disagrees', () => {
    const html = renderNotifications();

    expect(html).toContain('data-setting-key="turnNotify" data-setting-value="false"');
    expect(html).toContain('data-setting-key="autoResume" data-setting-value="true"');
    expect(html).toContain('data-setting-key="notifyCompaction" data-setting-value="false"');
    expect(html).toContain('C0123');
    expect(html).toContain('oc_456');
    expect(html).toContain('75s');
  });

  it('renders Advanced settings from the snapshot while DEBUG stays env-backed and read-only', () => {
    const html = renderAdvanced();

    expect(html).toContain('data-setting-key="eventLog" data-setting-value="true"');
    expect(html).toContain('data-setting-key="showToolCalls" data-setting-value="false"');
    expect(html).toContain('data-setting-key="disableUserContext" data-setting-value="true"');
    expect(html).toContain('data-setting-key="serverUpdateDisable" data-setting-value="false"');
    expect(html).toContain('data-setting-key="taskDispatchMaxConcurrent" data-setting-value="6"');
    expect(html).toContain('data-env-key="DEBUG" data-env-present="true" data-writable="false"');
  });

  it('keeps migrated controls missing and inert when the optional settings snapshot is absent', () => {
    const missing = { ...snapshot, settings: undefined };
    const notifications = renderNotifications(missing);
    const advanced = renderAdvanced(missing);

    expect(notifications.match(/data-setting-value="missing"/g)).toHaveLength(3);
    expect(advanced.match(/data-setting-value="missing"/g)).toHaveLength(5);
    expect(notifications).not.toContain('role="button"');
    expect(advanced).not.toContain('role="button"');
    expect(notifications).not.toContain('••••••••');
    expect(advanced).toContain('data-env-key="DEBUG" data-env-present="true" data-writable="false"');
  });

  it('renders nullable channels as absent and nullable concurrency as localized auto', () => {
    const nullable = {
      ...snapshot,
      env: [
        ...snapshot.env,
        { key: 'SLACK_ADMIN_CHANNEL', present: true, masked: '••••••••' },
        { key: 'FEISHU_ADMIN_CHANNEL', present: true, masked: '••••••••' },
        { key: 'TASK_DISPATCH_MAX_CONCURRENT', present: true, masked: '••••••••' },
      ],
      settings: settings.map((entry) => {
        if (entry.key === 'adminChannel' || entry.key === 'feishuAdminChannel'
          || entry.key === 'taskDispatchMaxConcurrent') return { ...entry, value: null };
        return entry;
      }),
    } satisfies ConfigSnapshot;
    const notifications = renderNotifications(nullable);
    const advanced = renderAdvanced(nullable);

    expect(notifications).toContain('settings.adminChannel: ');
    expect(notifications).toContain('settings.feishuAdminChannel: ');
    expect(notifications.match(/>—<\/span>/g)).toHaveLength(2);
    expect(notifications).not.toContain('••••••••');
    expect(advanced).toContain('data-setting-key="taskDispatchMaxConcurrent" data-setting-value="null"');
    expect(advanced).toContain('>auto<');
  });
});

describe('runtime setting writes', () => {
  it('a writable row requests the inverse snapshot value', () => {
    const onToggle = vi.fn();
    const row = RuntimeSettingToggleRow({
      settingKey: 'turnNotify',
      value: false,
      source: 'file',
      title: 'Turn notice',
      desc: 'desc',
      pending: false,
      onToggle,
    });
    const toggle = Children.toArray(row.props.children).find(isValidElement) as ReactElement<{
      onClick?: () => void;
    }>;

    toggle.props.onClick?.();
    expect(onToggle).toHaveBeenCalledWith('turnNotify', true);
  });

  it.each<[WritableSettingKey, boolean]>([
    ['turnNotify', true],
    ['autoResume', false],
    ['notifyCompaction', true],
    ['eventLog', false],
    ['showToolCalls', true],
    ['disableUserContext', false],
    ['serverUpdateDisable', true],
  ])('writes %s through config.set settings and refreshes the snapshot', async (key, nextValue) => {
    const set = vi.fn().mockResolvedValue({ written: true, section: 'settings' });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    await commitSettingToggle({ set, refresh, onError }, key, nextValue);

    expect(set).toHaveBeenCalledWith({ section: 'settings', value: { [key]: nextValue } });
    expect(refresh).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a failed write, skips refresh, and leaves snapshot-driven state unchanged', async () => {
    const before = structuredClone(snapshot.settings);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    await commitSettingToggle(
      { set: vi.fn().mockRejectedValue(new Error('denied')), refresh, onError },
      'eventLog',
      false,
    );

    expect(refresh).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('denied');
    expect(snapshot.settings).toEqual(before);
    expect(renderAdvanced()).toContain('data-setting-key="eventLog" data-setting-value="true"');
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

  it('binds both production panel wrappers to the runtime writer and settings views', () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const notifications = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <LangProvider><NotificationsPanel snapshot={snapshot} /></LangProvider>
      </QueryClientProvider>,
    );
    const advanced = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <LangProvider><AdvancedPanel snapshot={snapshot} /></LangProvider>
      </QueryClientProvider>,
    );

    expect(adapter.mutationOptions).toHaveBeenCalledTimes(2);
    expect(notifications).toContain('data-setting-key="turnNotify" data-setting-value="false"');
    expect(advanced).toContain('data-setting-key="eventLog" data-setting-value="true"');
    queryClient.clear();
  });

  it('binds config.set, suppresses repeat clicks through refresh, and renders the refreshed snapshot', async () => {
    const setGate = deferred<unknown>();
    const refreshGate = deferred<void>();
    adapter.set.mockReturnValue(setGate.promise);
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockReturnValue(refreshGate.promise);
    const writer = captureWriter(queryClient);

    writer.onToggle('turnNotify', true);
    writer.onToggle('turnNotify', true);
    await vi.waitFor(() => expect(adapter.set).toHaveBeenCalled());
    const callsBeforeWriteSettles = adapter.set.mock.calls.length;
    setGate.resolve({ written: true, section: 'settings' });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    writer.onToggle('turnNotify', true);
    await Promise.resolve();
    const callsDuringRefresh = adapter.set.mock.calls.length;
    refreshGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    writer.onToggle('autoResume', false);
    await vi.waitFor(() => expect(adapter.set).toHaveBeenCalledTimes(2));

    expect(adapter.mutationOptions).toHaveBeenCalledOnce();
    expect(adapter.set).toHaveBeenNthCalledWith(1, { section: 'settings', value: { turnNotify: true } }, expect.anything());
    expect(adapter.queryFilter).toHaveBeenNthCalledWith(1, {});
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ['config.get', {}] });
    expect([callsBeforeWriteSettles, callsDuringRefresh, adapter.set.mock.calls.length]).toEqual([1, 1, 2]);
    const refreshed = { ...snapshot, settings: settings.map((entry) => (
      entry.key === 'turnNotify' ? { ...entry, value: true } : entry
    )) };
    expect(renderNotifications(refreshed)).toContain('data-setting-key="turnNotify" data-setting-value="true"');
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
