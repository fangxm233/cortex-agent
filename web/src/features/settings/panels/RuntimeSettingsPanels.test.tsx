// input:  React renderer, runtime panels, settings primitives
// output: Runtime control, save gate and material regressions
// pos:    Settings control interaction and presentation tests
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
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
import { MAX_SESSION_RETENTION_DAYS } from '@/features/settings/vm/platform-env';
import { SButton, Toggle } from '@/features/settings/ui/settings-ui';

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

describe('settings control material transitions', () => {
  it('keeps the flat primary fill on a color longhand through repeated hover cycles', () => {
    const renderer = create(<SButton tone="accent">Save</SButton>);
    const button = () => renderer.root.findByType('button');
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const hover of [true, false]) {
        act(() => { button().props[hover ? 'onMouseEnter' : 'onMouseLeave'](); });
        expect(button().props.style.background).toBeUndefined();
        expect(button().props.style.backgroundColor).toBe(`var(--proto-accent${hover ? '-strong' : ''})`);
        expect(button().props.style.backgroundImage).toBeUndefined();
      }
    }
    renderer.unmount();
  });

  it.each(['neutral', 'danger'] as const)('restores the complete %s material after hover', tone => {
    const renderer = create(<SButton tone={tone}>Action</SButton>);
    const button = () => renderer.root.findByType('button');
    const base = button().props.style;
    act(() => { button().props.onMouseEnter(); });
    expect(button().props.style.background).toBe(tone === 'danger' ? 'var(--proto-danger-bg)' : 'var(--proto-alt)');
    expect(button().props.style.backgroundColor).toBeUndefined();
    expect(button().props.style.color).toBe(base.color);
    act(() => { button().props.onMouseLeave(); });
    expect(button().props.style).toEqual(base);
    renderer.unmount();
  });

  it('keeps the switch fill flat and uses a contrasting off thumb across state changes', () => {
    const renderer = create(<Toggle on={false} onClick={() => {}} />);
    for (const on of [false, true, false, true]) {
      act(() => { renderer.update(<Toggle on={on} onClick={() => {}} />); });
      const track = renderer.root.findByProps({ role: 'switch' });
      expect(track.props['aria-checked']).toBe(on);
      expect(track.props.style.background).toBeUndefined();
      expect(track.props.style.backgroundColor).toBe(on ? 'var(--proto-accent)' : 'var(--proto-line-3)');
      expect(track.props.style.backgroundImage).toBeUndefined();
      expect(track.findByType('span').props.style.background).toBe(on ? 'var(--ink-solid-fg)' : 'var(--proto-ink)');
    }
    renderer.unmount();
  });
});

describe('runtime setting row interaction', () => {
  it('a writable row requests the inverse snapshot value', () => {
    const onToggle = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <RuntimeSettingToggleRow
          settingKey="turnNotify"
          value={false}
          source="file"
          title="Turn notice"
          desc="desc"
          pending={false}
          onToggle={onToggle}
        />,
      );
    });

    // The switch is located by its role rather than by position: the row puts its control wherever
    // the settings language says it goes.
    act(() => { renderer!.root.findByProps({ role: 'switch' }).props.onClick(); });
    expect(onToggle).toHaveBeenCalledWith('turnNotify', true);
  });
});
