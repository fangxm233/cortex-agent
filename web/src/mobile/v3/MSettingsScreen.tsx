// 1l 设置 — the settings page drilled from the project page (scheme-mobile.dc.html 1l L601-663). A
// non-Tab drill page (the shell keeps the project Tab active); back returns to the project page. Wired
// to the REAL read scopes: `config.get` (redacted ~/.cortex/config snapshot) + `cost.summary` (today/
// month spend). The Daemon row drills into 1r (/m/daemon). Profile-switch + the two toggles are inert
// honest surfaces: config.set is budget/profiles-only server-side and there is NO .env write path, so
// they reflect real data but never fabricate a write (see MSettingsView GAP notes).
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang, useSetLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MSettingsView, type MSettingsCopy } from './MSettingsView';
import { buildMSettingsVm } from './m-settings-vm';

const COPY: { en: MSettingsCopy; zh: MSettingsCopy } = {
  en: {
    title: 'Settings',
    daemonStatus: 'daemon · connected',
    daemon: 'Daemon',
    profileTitle: 'Profile (global default)',
    profileTail: 'session-level switch is a chip in chat',
    switchLabel: 'Switch',
    budget: 'Budget',
    budgetUnit: '/day',
    notify: 'Notifications',
    notifySub: 'push on · long task > 10m · approvals instant',
    autoResume: 'Auto-resume on limit',
    autoResumeSub: 'resume threads after rate-limit clears',
    language: 'Language',
    platform: 'Platform',
    desktopEdit: 'Edit on desktop',
    templates: 'Thread templates',
    hooks: 'Hooks · 3-layer read-only',
    footerBrand: 'cortex mobile',
    footerHot: 'config hot-reload · no restart',
  },
  zh: {
    title: '设置',
    daemonStatus: 'daemon · 已连接',
    daemon: 'Daemon',
    profileTitle: 'Profile（全局默认）',
    profileTail: '会话级切换在 chat 内 chip',
    switchLabel: '切换',
    budget: '预算',
    budgetUnit: '日',
    notify: '通知',
    notifySub: '推送开 · 长任务 > 10m · 审批即时',
    autoResume: '限额自动续跑',
    autoResumeSub: 'rate-limit 解除后自动恢复线程',
    language: '语言',
    platform: 'Platform',
    desktopEdit: '桌面编辑',
    templates: 'Thread templates',
    hooks: 'Hooks · 三层只读',
    footerBrand: 'cortex mobile',
    footerHot: '配置热更新 · 免重启',
  },
};

const EMPTY_SNAPSHOT: ConfigSnapshot = {
  budget: null,
  profiles: null,
  machines: [],
  mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] },
  hooks: [],
  env: [],
};

export function MSettingsScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const setLang = useSetLang();
  const copy = pickCopy(lang, COPY);

  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const costQuery = useQuery(trpc.cost.summary.queryOptions({}));

  const vm = useMemo(
    () => buildMSettingsVm(configQuery.data ?? EMPTY_SNAPSHOT, costQuery.data),
    [configQuery.data, costQuery.data],
  );

  return (
    <MScreen label="1l 设置">
      {configQuery.isLoading ? (
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.title}</div>
      ) : (
        <MSettingsView
          vm={vm}
          copy={copy}
          lang={lang}
          onSetLang={setLang}
          onBack={() => navigate('/m/project')}
          onOpenDaemon={() => navigate('/m/daemon')}
        />
      )}
    </MScreen>
  );
}
