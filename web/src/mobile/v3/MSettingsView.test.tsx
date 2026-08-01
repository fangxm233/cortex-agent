// input:  mobile settings view, auth/hooks snapshot, UI copy
// output: API-key/OAuth entry and mounted-hook drill regressions
// pos:    Verifies mobile settings auth and hook entries
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { buildMSettingsVm } from './m-settings-vm';
import { MSettingsView, type MSettingsCopy } from './MSettingsView';

const copy: MSettingsCopy = {
  title: 'Settings', daemonStatus: 'connected', daemon: 'Daemon',
  machines: 'Machines', machinesOk: 'online',
  profileTitle: 'Profile', switchLabel: 'Switch', profileSheetTitle: 'Profiles',
  profileSheetCurrent: 'current', profileSheetFooter: 'new sessions', theme: 'Theme',
  themeLight: 'Light', themeDark: 'Dark', budget: 'Budget', budgetUnit: '/day',
  notify: 'Notifications', notifySub: 'notify', autoResume: 'Auto resume',
  autoResumeSub: 'resume', language: 'Language', platform: 'Platform',
  desktopEdit: 'Desktop', templates: 'Templates', hooks: 'Hooks',
  backendLogin: 'Backend login', backendLoginSub: 'Claude Code and PI API keys and OAuth',
  footerBrand: 'cortex mobile',
};

const snapshot: ConfigSnapshot = {
  budget: null,
  profiles: null,
  machines: [],
  mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] },
  hooks: [
    { id: 'managed-hook', event: 'agent:pre-tool', enabled: true, source: 'managed' },
    { id: 'user-hook', event: 'pi:message_end', enabled: false, source: 'user' },
    { id: 'template:review:end', event: 'cortex:thread.end', enabled: true, source: 'template-scoped' },
  ],
  env: [],
};

function renderHooks(value: ConfigSnapshot, onlineMachines = 0): string {
  return renderToStaticMarkup(
    <MSettingsView
      vm={buildMSettingsVm(value, undefined)}
      copy={copy}
      lang="en"
      onSetLang={() => {}}
      theme="light"
      onSetTheme={() => {}}
      onBack={() => {}}
      onOpenDaemon={() => {}}
      onlineMachines={onlineMachines}
      onOpenMachines={() => {}}
      onOpenHooks={() => {}}
      onOpenLogin={() => {}}
      profileSheet={null}
      onOpenProfile={() => {}}
      onCloseProfile={() => {}}
      onPickProfile={() => {}}
    />,
  );
}

describe('MSettingsView authentication', () => {
  it('renders the shared LoginFlow entry on mobile settings', () => {
    const html = renderHooks(snapshot);

    expect(html).toContain('data-auth-login-entry="mobile"');
    expect(html).toContain('aria-label="Backend login"');
    expect(html).toContain('Claude Code and PI API keys and OAuth');
  });
});

describe('MSettingsView hooks', () => {
  it('renders one drill-in row carrying the mounted-hook count and the desktop-edit pill', () => {
    const html = renderHooks(snapshot);

    expect(html).toContain('Hooks · 3');
    expect(html).toContain('Desktop');
    expect(html).toContain('aria-label="Hooks"');
  });

  it('no longer inlines individual hook declarations (they live on /m/settings/hooks)', () => {
    const html = renderHooks(snapshot);

    for (const value of [
      'managed-hook', 'user-hook', 'template:review:end',
      'agent:pre-tool', 'pi:message_end', 'cortex:thread.end',
    ]) {
      expect(html).not.toContain(value);
    }
  });

  it('renders a zero count rather than a separate empty state', () => {
    const html = renderHooks({ ...snapshot, hooks: [] });

    expect(html).toContain('Hooks · 0');
    expect(html).toContain('aria-label="Hooks"');
  });
});

describe('MSettingsView machines row', () => {
  it('renders the machines drill-in row with the real online count (moved off the Projects tab)', () => {
    const html = renderHooks(snapshot, 2);

    expect(html).toContain('Machines · 2 online');
    expect(html).toContain('aria-label="Machines"');
  });
});
