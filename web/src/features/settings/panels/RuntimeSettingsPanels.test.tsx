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

vi.mock('@/features/notifications/useNoticeHistory', () => ({ useNoticeHistory: vi.fn() }));

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
  { key: 'maxContextTokens', value: null, source: 'default' },
  { key: 'memoryIndexRegenEnabled', value: true, source: 'default' },
  { key: 'memoryIndexRegenIntervalMs', value: 86_400_000, source: 'default' },
  { key: 'adminChannel', value: 'C0123', source: 'file' },
  { key: 'feishuAdminChannel', value: 'oc_456', source: 'file' },
];

const snapshot: ConfigSnapshot = {
  budget: null,
  models: { default: null, favorites: [], memory: {} }, selectionDefault: null,
  machines: [],
  mcp: null,
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
  it.each([true, false])('shows DEBUG enabled=%s even when the variable is present', (enabled) => {
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LangProvider><AdvancedPanelView
        snapshot={{ ...snapshot, env: [{ key: 'DEBUG', present: true, masked: '••••••••', enabled }] }}
        pending={false} onToggle={() => {}} onSet={() => {}} />
      </LangProvider>);
    });
    expect(renderer!.root.findByProps({ 'data-env-key': 'DEBUG' }).props['data-env-present']).toBe(String(enabled));
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
  });

  it('gates the PI compaction reserve on its token range', () => {
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

  it('saves the max context cap as a whole token count, or null once cleared', () => {
    const onSet = vi.fn();
    let renderer: ReturnType<typeof create>;
    const render = (value: number | null) => (
      <LangProvider>
        <AdvancedPanelView
          snapshot={{ ...snapshot, settings: settings.map((entry) => (
            entry.key === 'maxContextTokens' ? { ...entry, value } : entry)) }}
          pending={false} onToggle={() => {}} onSet={onSet} />
      </LangProvider>
    );
    act(() => { renderer = create(render(null)); });
    const input = () => renderer!.root.findByProps({ 'data-number-input': 'maxContextTokens' });
    const save = () => renderer!.root.findByProps({ 'data-number-save': 'maxContextTokens' });
    expect(input().props.value).toBe('');
    expect(save().props.disabled).toBe(true);

    act(() => { input().props.onChange({ target: { value: '99999' } }); });
    expect(save().props.disabled).toBe(true);
    act(() => { input().props.onChange({ target: { value: '450000' } }); });
    act(() => { save().props.onClick(); });
    expect(onSet).toHaveBeenLastCalledWith('maxContextTokens', 450_000);

    act(() => { renderer!.update(render(450_000)); });
    act(() => { input().props.onChange({ target: { value: '' } }); });
    expect(save().props.disabled).toBe(false);
    act(() => { save().props.onClick(); });
    expect(onSet).toHaveBeenLastCalledWith('maxContextTokens', null);
  });
});

describe('advanced panel sections', () => {
  function mount(entries: ConfigSettingEntry[] = settings, onToggle = vi.fn()) {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LangProvider><AdvancedPanelView snapshot={{ ...snapshot, settings: entries }}
        pending={false} onToggle={onToggle} onSet={() => {}} /></LangProvider>);
    });
    return renderer;
  }
  const row = (renderer: ReturnType<typeof create>, key: string) =>
    renderer.root.findByProps({ 'data-setting-key': key });

  it('groups the rows under titled sections in a fixed order', () => {
    const renderer = mount();
    const sections = renderer.root.findAll((node) => typeof node.props['data-advanced-section'] === 'string'
      && typeof node.type !== 'string');
    expect(sections.map((node) => node.props['data-advanced-section']))
      .toEqual(['agent', 'updates', 'data', 'diagnostics']);
    expect(renderer.root.findAllByProps({ 'data-setting-key': 'showToolCalls' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-env-key': 'CORTEX_GPU_MONITOR_MOCK' })).toHaveLength(0);
  });

  it('shows USER.md injection as on when the disable key is off, and writes the disable key', () => {
    const onToggle = vi.fn();
    const renderer = mount(settings.map((entry) => (
      entry.key === 'disableUserContext' ? { ...entry, value: false } : entry)), onToggle);
    const toggle = row(renderer, 'disableUserContext').findByProps({ role: 'switch' });
    expect(toggle.props['aria-checked']).toBe(true);
    act(() => { toggle.props.onClick(); });
    expect(onToggle).toHaveBeenCalledWith('disableUserContext', true);
  });

  it('locks automatic server installs while the update check is off', () => {
    const entries: ConfigSettingEntry[] = [...settings, { key: 'serverAutoUpdate', value: true, source: 'default' }];
    const checkOn = mount(entries);
    expect(row(checkOn, 'serverAutoUpdate').findByProps({ role: 'switch' }).props.onClick).toBeTypeOf('function');
    const checkOff = mount(entries.map((entry) => (
      entry.key === 'serverUpdateDisable' ? { ...entry, value: true } : entry)));
    expect(row(checkOff, 'serverAutoUpdate').findByProps({ role: 'switch' }).props.onClick).toBeUndefined();
  });
});

describe('settings control material transitions', () => {
  it('keeps the flat ink primary fill on a color longhand through repeated hover cycles', () => {
    const renderer = create(<SButton tone="primary">Save</SButton>);
    const button = () => renderer.root.findByType('button');
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const hover of [true, false]) {
        act(() => { button().props[hover ? 'onMouseEnter' : 'onMouseLeave'](); });
        expect(button().props.style.background).toBeUndefined();
        // Ink, never the accent: a filled accent button would compete with the state it acts on.
        expect(button().props.style.backgroundColor).toBe(hover
          ? 'color-mix(in srgb, var(--ink-solid-bg) 88%, var(--ink-solid-fg))' : 'var(--ink-solid-bg)');
        expect(button().props.style.color).toBe('var(--ink-solid-fg)');
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
