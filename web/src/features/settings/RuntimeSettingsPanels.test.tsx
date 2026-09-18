import { Children, isValidElement, type ReactElement } from 'react';
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

const noticeHistory = vi.hoisted(() => ({
  entries: [] as Array<{ id: string; ts: string; level: 'info' | 'warning' | 'error'; title?: string; text: string }>,
  cap: 50,
  loading: false,
  error: false,
}));

// The panel's notice card reads the server ring through tRPC; these are pure render assertions, so
// the resource hook is stubbed rather than standing up a TRPCProvider.
vi.mock('@/features/notifications/useNoticeHistory', () => ({
  useNoticeHistory: () => noticeHistory,
}));

import {
  AdvancedPanelView,
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
  { key: 'piCompactReserveTokens', value: 16_384, source: 'default' },
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

describe('runtime settings panel save gates', () => {

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
  });

  it('accepts 0 as off for the PI mid-turn percent and rejects a value below the range', () => {
    const onSet = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <LangProvider>
          <AdvancedPanelView snapshot={snapshot} pending={false} onToggle={() => {}} onSet={onSet} />
        </LangProvider>,
      );
    });
    const input = renderer!.root.findByProps({ 'data-number-input': 'piCompactReserveTokens' });
    const save = () => renderer!.root.findByProps({ 'data-number-save': 'piCompactReserveTokens' });
    expect(save().props.disabled).toBe(true);

    act(() => { input.props.onChange({ target: { value: '32768' } }); });
    expect(save().props.disabled).toBe(false);

    act(() => { input.props.onChange({ target: { value: '1023' } }); });
    expect(save().props.disabled).toBe(true);

    act(() => { input.props.onChange({ target: { value: '32768' } }); });
    act(() => { save().props.onClick(); });
    expect(onSet).toHaveBeenCalledWith('piCompactReserveTokens', 32_768);
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
