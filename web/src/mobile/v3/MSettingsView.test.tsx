// input:  Mobile settings view model, copy, and drill-in callbacks
// output: Mobile settings drill-in wiring regression coverage
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
      accountsTitle: 'Accounts', accountsConnectedMark: 'connected',
      accountsDisconnected: 'disconnected', accountsPiSummary: 'PI {count}',
    }),
  };
});

const copy: MSettingsCopy = {
  title: 'Settings', daemonStatus: 'connected', daemon: 'Daemon', machines: 'Machines',
  machinesOk: 'online', profileTitle: 'Profile', switchLabel: 'Switch',
  profileSheetTitle: 'Profile', profileSheetCurrent: 'current', profileSheetFooter: 'New sessions',
  appearance: 'Appearance', budget: 'Budget', budgetUnit: '/day',
  usage: 'Usage', notify: 'Notifications', notifySub: 'On', autoResume: 'Auto resume',
  autoResumeSub: 'On', platform: 'Platform', desktopEdit: 'Desktop',
  templates: 'Templates', hooks: 'Hooks', footerBrand: 'cortex mobile',
};

const vm: MSettingsVm = {
  daemonHost: null, profileName: null, profileModel: null, profileThinking: null,
  profiles: [], budgetSpendLabel: '$0 / $0', budgetBarPct: '0%', notifyOn: false,
  autoResumeOn: false, platforms: [], templatesCount: 0, hooks: [],
};

function renderSettings(overrides: Partial<Parameters<typeof MSettingsView>[0]> = {}) {
  return create(
    <MSettingsView
      vm={vm} copy={copy} onBack={() => {}} onOpenDaemon={() => {}}
      onlineMachines={0} onOpenMachines={() => {}} onOpenHooks={() => {}}
      accountsSummary={{ claudeLoggedIn: false, piLoggedInCount: 0 }} onOpenAccounts={() => {}}
      onOpenAppearance={() => {}} onOpenUsage={() => {}} profileSheet={null}
      onOpenProfile={() => {}} onCloseProfile={() => {}} onPickProfile={() => {}}
      {...overrides}
    />,
  );
}

describe('MSettingsView drill-ins', () => {
  // Appearance moved off this screen into /m/settings/appearance; the top level only routes to it.
  it('routes the appearance drill-in', () => {
    const onOpenAppearance = vi.fn();
    const renderer = renderSettings({ onOpenAppearance });

    act(() => renderer.root.findByProps({ 'data-settings-entry': 'appearance' }).props.onClick());

    expect(onOpenAppearance).toHaveBeenCalled();
  });

  it('keeps the usage drill-in separate from appearance', () => {
    const onOpenUsage = vi.fn();
    const renderer = renderSettings({ onOpenUsage });

    act(() => renderer.root.findByProps({ 'data-settings-entry': 'usage' }).props.onClick());

    expect(onOpenUsage).toHaveBeenCalled();
  });

  it('no longer renders accent controls at the settings top level', () => {
    const renderer = renderSettings();

    expect(renderer.root.findAllByProps({ 'data-accent-picker': true })).toHaveLength(0);
  });
});
