// input:  Mobile settings view model, copy, and appearance callbacks
// output: Mobile accent-control wiring regression coverage
// pos:    Interaction test for mobile appearance settings
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
  theme: 'Theme', themeLight: 'Light', themeDark: 'Dark', themeSystem: 'System',
  accent: 'Accent', accentDefault: 'Default', accentBlue: 'Blue', accentTeal: 'Teal',
  accentViolet: 'Violet', accentRose: 'Rose', accentOrange: 'Orange',
  accentCustom: 'Custom hue', accentReset: 'Reset', budget: 'Budget', budgetUnit: '/day',
  usage: 'Usage', notify: 'Notifications', notifySub: 'On', autoResume: 'Auto resume',
  autoResumeSub: 'On', language: 'Language', platform: 'Platform', desktopEdit: 'Desktop',
  templates: 'Templates', hooks: 'Hooks', footerBrand: 'cortex mobile',
};

const vm: MSettingsVm = {
  daemonHost: null, profileName: null, profileModel: null, profileThinking: null,
  profiles: [], budgetSpendLabel: '$0 / $0', budgetBarPct: '0%', notifyOn: false,
  autoResumeOn: false, platforms: [], templatesCount: 0, hooks: [],
};

function renderSettings(onSetAccentHue: (hue: number | null) => void) {
  return create(
    <MSettingsView
      vm={vm} copy={copy} lang="en" onSetLang={() => {}} theme="system" onSetTheme={() => {}}
      accentHue={null} onSetAccentHue={onSetAccentHue} onBack={() => {}} onOpenDaemon={() => {}}
      onlineMachines={0} onOpenMachines={() => {}} onOpenHooks={() => {}}
      accountsSummary={{ claudeLoggedIn: false, piLoggedInCount: 0 }} onOpenAccounts={() => {}}
      onOpenUsage={() => {}} profileSheet={null} onOpenProfile={() => {}} onCloseProfile={() => {}}
      onPickProfile={() => {}}
    />,
  );
}

describe('MSettingsView appearance', () => {
  it('routes mobile accent selections', () => {
    const onSetAccentHue = vi.fn();
    const renderer = renderSettings(onSetAccentHue);

    act(() => renderer.root.findByProps({ 'data-accent-preset': 'rose' }).props.onClick());

    expect(onSetAccentHue).toHaveBeenCalledWith(10);
  });
});
