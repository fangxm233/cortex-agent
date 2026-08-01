// input:  config/cost queries, language/theme/login state, navigation
// output: data-bound mobile settings with auth and hooks entries
// pos:    Mobile settings query and mutation container
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang, useSetLang } from '@/i18n';
import { useTheme, useSetTheme } from '@/theme';
import { pickCopy } from '@/mobile/ui/format';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MSettingsView, type MSettingsCopy } from './MSettingsView';
import { buildMSettingsVm } from './m-settings-vm';
import { onlineMachineCount } from './m-project-vm';
import { buildProfileSheetItems } from './m-chat-vm';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';

const COPY: { en: MSettingsCopy; zh: MSettingsCopy } = {
  en: {
    title: 'Settings',
    daemonStatus: 'daemon · connected',
    daemon: 'Daemon',
    machines: 'Machines',
    machinesOk: 'online',
    profileTitle: 'Profile (global default)',
    switchLabel: 'Switch',
    profileSheetTitle: 'Global default profile',
    profileSheetCurrent: 'current',
    profileSheetFooter: 'Applies to new sessions and new threads',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
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
    hooks: 'Hooks',
    backendLogin: 'Backend login',
    backendLoginSub: 'Claude Code and PI API keys',
    footerBrand: 'cortex mobile',
  },
  zh: {
    title: '设置',
    daemonStatus: 'daemon · 已连接',
    daemon: 'Daemon',
    machines: '机器',
    machinesOk: '台正常',
    profileTitle: 'Profile（全局默认）',
    switchLabel: '切换',
    profileSheetTitle: '全局默认 Profile',
    profileSheetCurrent: '当前',
    profileSheetFooter: '切换后新会话 / 新线程使用',
    theme: '主题',
    themeLight: '浅色',
    themeDark: '深色',
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
    hooks: '钩子',
    backendLogin: 'Backend 登录',
    backendLoginSub: 'Claude Code 与 PI API key',
    footerBrand: 'cortex mobile',
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
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const lang = useLang();
  const setLang = useSetLang();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const { openLogin } = useLoginFlow();
  const copy = pickCopy(lang, COPY);

  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const costQuery = useQuery(trpc.cost.summary.queryOptions({}));
  // Live machines.list (online flags) for the 机器 drill-in row — moved here from the Projects tab.
  const machinesQuery = useQuery(trpc.machines.list.queryOptions({}));
  const onlineMachines = onlineMachineCount(machinesQuery.data ?? []);

  const vm = useMemo(
    () => buildMSettingsVm(configQuery.data ?? EMPTY_SNAPSHOT, costQuery.data),
    [configQuery.data, costQuery.data],
  );

  // profile switch: real config.set `profiles` write (re-points defaultProfile in profiles.json).
  const [profileOpen, setProfileOpen] = useState(false);
  const setProfileMut = useMutation(
    trpc.config.set.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.config.get.queryFilter({})),
    }),
  );
  const profileSheet = profileOpen
    ? buildProfileSheetItems(vm.profiles, vm.profileName ?? '')
    : null;
  const onPickProfile = (name: string) => {
    setProfileOpen(false);
    if (name === vm.profileName) return;
    setProfileMut.mutate({ section: 'profiles', value: { defaultProfile: name } });
  };

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
          theme={theme}
          onSetTheme={setTheme}
          onBack={() => navigate('/m/project')}
          onOpenDaemon={() => navigate('/m/daemon')}
          onlineMachines={onlineMachines}
          onOpenMachines={() => navigate('/m/machines')}
          onOpenHooks={() => navigate('/m/settings/hooks')}
          onOpenLogin={openLogin}
          profileSheet={profileSheet}
          onOpenProfile={() => setProfileOpen(true)}
          onCloseProfile={() => setProfileOpen(false)}
          onPickProfile={onPickProfile}
        />
      )}
    </MScreen>
  );
}
