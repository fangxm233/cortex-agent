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
  it('routes real entries and leaves desktop-only authoring non-interactive', () => {
    const onOpenSection = vi.fn();
    const renderer = renderSettings({ onOpenSection });

    act(() => renderer.root.findByProps({ 'data-settings-entry': 'budget' }).props.onClick());
    expect(onOpenSection).toHaveBeenCalledWith('budget');
    expect(renderer.root.findByProps({ 'data-settings-entry': 'templates' }).props.onClick).toBeUndefined();
    expect(renderer.root.findByProps({ 'data-settings-entry': 'plugins' }).props.onClick).toBeUndefined();
  });
});
