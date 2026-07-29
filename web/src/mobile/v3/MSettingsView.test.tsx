// input:  mobile settings view, mounted-hook snapshot, UI copy
// output: mobile mounted-hook and empty-state regressions
// pos:    Verifies mobile settings exposes real hook state
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { buildMSettingsVm } from './m-settings-vm';
import { MSettingsView, type MSettingsCopy } from './MSettingsView';

const copy: MSettingsCopy = {
  title: 'Settings', daemonStatus: 'connected', daemon: 'Daemon',
  profileTitle: 'Profile', switchLabel: 'Switch', profileSheetTitle: 'Profiles',
  profileSheetCurrent: 'current', profileSheetFooter: 'new sessions', theme: 'Theme',
  themeLight: 'Light', themeDark: 'Dark', budget: 'Budget', budgetUnit: '/day',
  notify: 'Notifications', notifySub: 'notify', autoResume: 'Auto resume',
  autoResumeSub: 'resume', language: 'Language', platform: 'Platform',
  desktopEdit: 'Desktop', templates: 'Templates', hooks: 'Hooks',
  hookEnabled: 'Enabled', hookDisabled: 'Disabled', noHooks: 'No mounted hooks',
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

function renderHooks(value: ConfigSnapshot): string {
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
      profileSheet={null}
      onOpenProfile={() => {}}
      onCloseProfile={() => {}}
      onPickProfile={() => {}}
    />,
  );
}

describe('MSettingsView hooks', () => {
  it('renders mounted hook identity, event, state, and source', () => {
    const html = renderHooks(snapshot);

    for (const value of [
      'managed-hook', 'agent:pre-tool', 'managed', 'Enabled',
      'user-hook', 'pi:message_end', 'user', 'Disabled',
      'template:review:end', 'cortex:thread.end', 'template-scoped',
    ]) {
      expect(html).toContain(value);
    }
  });

  it('renders the localized empty state without mounted-hook rows', () => {
    const html = renderHooks({ ...snapshot, hooks: [] });

    expect(html).toContain('No mounted hooks');
    for (const id of ['managed-hook', 'user-hook', 'template:review:end']) {
      expect(html).not.toContain(id);
    }
  });
});
