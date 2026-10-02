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
      accountsPiSummary: 'PI {count}', mHelpUpdates: 'Check for updates', updateCheckBusy: 'Checking for updates…',
    }),
  };
});

const copy: MSettingsCopy = {
  title: 'Settings', daemon: 'Daemon', machinesOk: 'online',
  desktopOnly: 'Edit on desktop', inspectOnly: 'View only',
  footerBrand: 'cortex mobile', switchProfile: 'Switch',
};

const vm: MSettingsVm = { profileName: 'default', profileModel: 'sonnet', profileThinking: 'high' };

function renderSettings(overrides: Partial<Parameters<typeof MSettingsView>[0]> = {}) {
  return create(
    <MSettingsView
      vm={vm} copy={copy} onBack={() => {}} onOpenDaemon={() => {}}
      onlineMachines={2} connectionStatus="connected"
      onOpenSection={() => {}} checkingUpdates={false} onCheckUpdates={() => {}} {...overrides}
    />,
  );
}

describe('MSettingsView parity', () => {
  it('exposes the shared manual check and disables it while checking', () => {
    const onCheckUpdates = vi.fn();
    const renderer = renderSettings({ onCheckUpdates });
    const button = renderer.root.findByProps({ 'data-settings-updates': true });
    expect(button.props.disabled).toBe(false);
    expect(button.findAllByType('span')[0].children).toEqual(['Check for updates']);
    act(() => button.props.onClick());
    expect(onCheckUpdates).toHaveBeenCalledOnce();
    renderer.unmount();
    const busy = renderSettings({ checkingUpdates: true });
    const busyButton = busy.root.findByProps({ 'data-settings-updates': true });
    expect(busyButton.props.disabled).toBe(true);
    expect(busyButton.findAllByType('span')[0].children).toEqual(['Checking for updates…']);
    busy.unmount();
  });
  it('routes real entries and leaves desktop-only authoring non-interactive', () => {
    const onOpenSection = vi.fn();
    const renderer = renderSettings({ onOpenSection });

    act(() => renderer.root.findByProps({ 'data-settings-entry': 'budget' }).props.onClick());
    expect(onOpenSection).toHaveBeenCalledWith('budget');
    expect(renderer.root.findByProps({ 'data-settings-entry': 'templates' }).props.onClick).toBeUndefined();
    expect(renderer.root.findByProps({ 'data-settings-entry': 'plugins' }).props.onClick).toBeUndefined();
  });
});
