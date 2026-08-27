// input:  config/auth queries, shared account facts, machine roster, and connection state
// output: immediately rendered mobile settings index with shared summaries
// pos:    Mobile settings query adapter preserving the current settings presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { useMachinesResource } from '@/features/machines/useMachinesResource';
import type { SettingsSectionKey } from '@/features/settings/settings-nav';
import { useLang } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { pickCopy } from '@/mobile/ui/format';
import { buildAccountsVm } from '@/features/settings/accounts-vm';
import { onlineMachineCount } from './m-project-vm';
import { buildMSettingsVm } from './m-settings-vm';
import { MSettingsView, type MSettingsCopy } from './MSettingsView';

const COPY: { en: MSettingsCopy; zh: MSettingsCopy } = {
  en: { title: 'Settings', daemon: 'Daemon', machinesOk: 'online', desktopOnly: 'Edit on desktop',
    inspectOnly: 'View only', footerBrand: 'cortex mobile', switchProfile: 'Switch' },
  zh: { title: '设置', daemon: 'Daemon', machinesOk: '台在线', desktopOnly: '桌面编辑',
    inspectOnly: '仅查看', footerBrand: 'cortex mobile', switchProfile: '切换' },
};

const EMPTY_SNAPSHOT: ConfigSnapshot = {
  budget: null, profiles: null, machines: [], mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] }, hooks: [], env: [], settings: [],
};

const SECTION_PATH: Record<SettingsSectionKey, string> = {
  appearance: '/m/settings/appearance', platform: '/m/settings/platform',
  accounts: '/m/settings/accounts', profiles: '/m/settings/profiles', budget: '/m/settings/budget',
  usage: '/m/settings/usage', machines: '/m/machines', templates: '/m/settings/templates',
  plugins: '/m/settings/plugins', mcp: '/m/settings/mcp', notifications: '/m/settings/notifications',
  hooks: '/m/settings/hooks', advanced: '/m/settings/advanced',
};

export function MSettingsScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const copy = pickCopy(useLang(), COPY);
  const connectionStatus = useConnectionStatus();
  const config = useQuery(trpc.config.get.queryOptions({}));
  const auth = useQuery(trpc.auth.status.queryOptions({}));
  const machines = useMachinesResource();
  const vm = useMemo(() => buildMSettingsVm(config.data ?? EMPTY_SNAPSHOT, undefined), [config.data]);
  const accounts = useMemo(() => auth.data ? buildAccountsVm(auth.data).summary
    : { claudeLoggedIn: false, piLoggedInCount: 0 }, [auth.data]);
  return <MSettingsView vm={vm} copy={copy} connectionStatus={connectionStatus}
    accountsSummary={accounts} onlineMachines={onlineMachineCount(machines.machines)}
    onBack={() => navigate('/m/project')} onOpenDaemon={() => navigate('/m/daemon')}
    onOpenSection={(section) => navigate(SECTION_PATH[section])} />;
}
