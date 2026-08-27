// input:  desktop runtime panel views and settings/env fixtures
// output: settings-backed rows, validation and toggle interaction regressions
// pos:    Verifies desktop Notifications and Advanced presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Children, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigSnapshot, ConfigSettingEntry } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

vi.mock('@/design', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/design')>();
  return {
    ...actual,
    Select: ({ options, value, ...props }: any) => (
      <div data-select-control data-select-value={String(value)} {...props}>
        {options.map((option: any) => <span key={String(option.value)}>{option.label}</span>)}
      </div>
    ),
  };
});

import {
  AdvancedPanelView,
  NotificationsPanelView,
  RuntimeSettingToggleRow,
} from './RuntimeSettingsPanels';
import { MAX_SESSION_RETENTION_DAYS } from './platform-env';

const settings: ConfigSettingEntry[] = [
  { key: 'turnNotify', value: false, source: 'file' },
  { key: 'turnNotifyThresholdS', value: 75, source: 'file' },
  { key: 'autoResume', value: true, source: 'default' },
  { key: 'notifyCompaction', value: false, source: 'file' },
  { key: 'eventLog', value: true, source: 'default' },
  { key: 'diskMonitor', value: true, source: 'default' },
  { key: 'showToolCalls', value: false, source: 'file' },
  { key: 'disableUserContext', value: true, source: 'env' },
  { key: 'serverUpdateDisable', value: false, source: 'default' },
  { key: 'sessionRetentionDays', value: 30, source: 'env' },
  { key: 'taskDispatchMaxConcurrent', value: 6, source: 'file' },
  { key: 'taskDispatchEnabled', value: false, source: 'file' },
  { key: 'taskDispatchIntervalMs', value: 30_000, source: 'file' },
  { key: 'taskArchiveEnabled', value: true, source: 'default' },
  { key: 'taskArchiveIntervalMs', value: 21_600_000, source: 'default' },
  { key: 'memoryIndexRegenEnabled', value: true, source: 'default' },
  { key: 'memoryIndexRegenIntervalMs', value: 86_400_000, source: 'default' },
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
      <AdvancedPanelView snapshot={value} pending={false} onToggle={() => {}} onSet={() => {}} />
    </LangProvider>,
  );
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
    expect(html).toContain('data-setting-key="diskMonitor" data-setting-value="true"');
    expect(html).toContain('data-setting-key="showToolCalls" data-setting-value="false"');
    expect(html).toContain('data-setting-key="disableUserContext" data-setting-value="true"');
    expect(html).toContain('data-setting-key="serverUpdateDisable" data-setting-value="false"');
    expect(html).toContain('data-setting-key="sessionRetentionDays" data-setting-value="30"');
    expect(html).toContain('data-setting-source="env"');
    expect(html).toContain('data-setting-key="taskDispatchMaxConcurrent" data-setting-value="6"');
    expect(html).toContain('data-setting-key="taskDispatchEnabled" data-setting-value="false"');
    expect(html).toContain('data-setting-key="taskDispatchIntervalMs" data-setting-value="30000"');
    expect(html).toContain('data-setting-key="taskArchiveEnabled" data-setting-value="true"');
    expect(html).toContain('data-setting-key="memoryIndexRegenIntervalMs" data-setting-value="86400000"');
    expect(html).toContain('value="30"');
    expect(html).toContain('data-duration-unit="taskDispatchIntervalMs"');
    expect(html).toContain('data-select-value="sec"');
    expect(html).toContain('value="6"');
    expect(html).toContain('data-setting-key="sessionRetentionDays" data-setting-value="30"');
    expect(html).toContain('data-number-input="sessionRetentionDays"');
    expect(html).toContain('data-number-save="sessionRetentionDays"');
    expect(html).toContain('value="30"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-duration-unit="taskArchiveIntervalMs"');
    expect(html).toContain('data-select-value="hr"');
    expect(html).toContain('data-env-key="DEBUG" data-env-present="true" data-writable="false"');
  });

  it('keeps migrated controls missing and inert when the optional settings snapshot is absent', () => {
    const missing = { ...snapshot, settings: undefined };
    const notifications = renderNotifications(missing);
    const advanced = renderAdvanced(missing);

    expect(notifications.match(/data-setting-value="missing"/g)).toHaveLength(3);
    expect((advanced.match(/data-setting-value="missing"/g) ?? []).length).toBeGreaterThanOrEqual(6);
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

  it('gates session retention save on the same max bound the server validates', () => {
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <LangProvider>
          <AdvancedPanelView snapshot={snapshot} pending={false} onToggle={() => {}} onSet={() => {}} />
        </LangProvider>,
      );
    });

    const input = renderer!.root.findByProps({ 'data-number-input': 'sessionRetentionDays' });
    const save = renderer!.root.findByProps({ 'data-number-save': 'sessionRetentionDays' });
    expect(save.props.disabled).toBe(true);

    act(() => { input.props.onChange({ target: { value: String(MAX_SESSION_RETENTION_DAYS) } }); });
    expect(renderer!.root.findByProps({ 'data-number-save': 'sessionRetentionDays' }).props.disabled).toBe(false);

    act(() => { input.props.onChange({ target: { value: String(MAX_SESSION_RETENTION_DAYS + 1) } }); });
    const blocked = renderer!.root.findByProps({ 'data-number-save': 'sessionRetentionDays' });
    expect(blocked.props.disabled).toBe(true);
    expect(blocked.props.title).toContain(String(MAX_SESSION_RETENTION_DAYS));
  });
});

describe('runtime setting row interaction', () => {
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
});
