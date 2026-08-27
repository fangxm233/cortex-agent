// input:  Mobile settings view model, connection state and section callbacks
// output: Mobile settings parity and interaction regression coverage
// pos:    Interaction test for the mobile settings top level
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MSettingsView, type MSettingsCopy } from './MSettingsView';
import type { MSettingsVm } from './m-settings-vm';

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>();
  return {
    ...actual,
    useVocab: () => ({
      stNavAppearance: 'Appearance', stNavPlatform: 'Platform', stNavAccounts: 'Accounts',
      stNavProfiles: 'Profiles', stNavBudget: 'Budget', stNavUsage: 'Usage',
      stNavMachines: 'Machines', stNavTemplates: 'Templates', stNavPlugins: 'Plugins',
      stNavMcp: 'MCP', stNavNotifications: 'Notifications', stNavHooks: 'Hooks',
      stNavAdvanced: 'Advanced', connConnected: 'Connected', connConnecting: 'Connecting',
      connReconnecting: 'Reconnecting', connDisconnected: 'Disconnected',
      accountsConnectedMark: 'connected', accountsDisconnected: 'disconnected',
      accountsPiSummary: 'PI {count}',
    }),
  };
});

const copy: MSettingsCopy = {
  title: 'Settings', daemon: 'Daemon', machinesOk: 'online',
  desktopOnly: 'Edit on desktop', inspectOnly: 'View only',
  footerBrand: 'cortex mobile', switchProfile: 'Switch',
};

const vm: MSettingsVm = {
  daemonHost: null, profileName: 'default', profileModel: 'sonnet', profileThinking: 'high',
  profiles: [], budgetSpendLabel: '$0 / $10', budgetBarPct: '0%', notifyOn: true,
  autoResumeOn: false, notifyEnabledCount: 1, platforms: ['slack'], templatesCount: 2,
  pluginsCount: null, mcpServers: ['filesystem'], hooks: [],
};

function renderSettings(overrides: Partial<Parameters<typeof MSettingsView>[0]> = {}) {
  return create(
    <MSettingsView
      vm={vm} copy={copy} onBack={() => {}} onOpenDaemon={() => {}}
      onlineMachines={2} connectionStatus="connected"
      onOpenSection={() => {}} {...overrides}
    />,
  );
}

describe('MSettingsView parity', () => {
  it('keeps Daemon first and restores the dedicated Profiles card second', () => {
    const renderer = renderSettings();
    const entries = renderer.root.findAll((node) => node.props['data-settings-entry']);

    expect(entries.map((node) => node.props['data-settings-entry'])).toEqual([
      'profiles', 'appearance', 'platform', 'accounts', 'budget', 'usage', 'machines',
      'templates', 'plugins', 'mcp', 'notifications', 'hooks', 'advanced',
    ]);
    const buttons = renderer.root.findAllByType('button');
    const daemonIndex = buttons.findIndex((button) => button.props['data-settings-daemon']);
    const profileIndex = buttons.findIndex((button) => button.props['data-settings-entry'] === 'profiles');
    expect(profileIndex).toBe(daemonIndex + 1);
  });

  it('keeps nonessential rows title-only', () => {
    const renderer = renderSettings();
    const titleOnly = ['accounts', 'budget', 'platform', 'templates', 'mcp', 'notifications', 'hooks'];
    for (const section of titleOnly) {
      const row = renderer.root.findByProps({ 'data-settings-entry': section });
      const text = row.findAllByType('span').flatMap((node) => node.children).join(' ');
      expect(text).not.toMatch(/connected|\$0|slack|2|filesystem|1\/3/);
    }
  });

  it('routes real entries and leaves desktop-only authoring non-interactive', () => {
    const onOpenSection = vi.fn();
    const renderer = renderSettings({ onOpenSection });

    act(() => renderer.root.findByProps({ 'data-settings-entry': 'budget' }).props.onClick());
    expect(onOpenSection).toHaveBeenCalledWith('budget');
    expect(renderer.root.findByProps({ 'data-settings-entry': 'templates' }).props.onClick).toBeUndefined();
    expect(renderer.root.findByProps({ 'data-settings-entry': 'plugins' }).props.onClick).toBeUndefined();
  });

  it('renders the live connection label rather than fixed connected copy', () => {
    const renderer = renderSettings({ connectionStatus: 'reconnecting' });

    expect(renderer.root.findAllByType('span').some((node) => node.children.includes('Reconnecting'))).toBe(true);
  });
});
