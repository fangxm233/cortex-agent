// input:  config/cost/auth/machine queries and live connection state
// output: canonical mobile settings index and drill-in navigation
// pos:    Mobile settings query container
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import type { SettingsSectionKey } from '@/features/settings/settings-nav';
import { useLang } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { pickCopy } from '@/mobile/ui/format';
import { MScreen, MC } from '@/mobile/ui/kit';
import { buildAccountsVm } from './m-accounts-vm';
import { onlineMachineCount } from './m-project-vm';
import { buildMSettingsVm } from './m-settings-vm';
import { MSettingsView, type MSettingsCopy } from './MSettingsView';

const COPY: { en: MSettingsCopy; zh: MSettingsCopy } = {
  en: { title: 'Settings', daemon: 'Daemon', machinesOk: 'online', desktopOnly: 'Edit on desktop',
    inspectOnly: 'View only', enabled: 'enabled', footerBrand: 'cortex mobile' },
  zh: { title: '设置', daemon: 'Daemon', machinesOk: '台在线', desktopOnly: '桌面编辑',
    inspectOnly: '仅查看', enabled: '已开启', footerBrand: 'cortex mobile' },
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

function SettingsMessage({ message, failed = false }: { message: string; failed?: boolean }) {
  return <MScreen label="1l Settings"><div style={{ padding: 16, color: failed ? MC.fail : MC.muted,
    fontSize: 13 }}>{message}</div></MScreen>;
}

export function MSettingsScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const copy = pickCopy(useLang(), COPY);
  const connectionStatus = useConnectionStatus();
  const config = useQuery(trpc.config.get.queryOptions({}));
  const cost = useQuery(trpc.cost.summary.queryOptions({}));
  const auth = useQuery(trpc.auth.status.queryOptions({}));
  const machines = useQuery(trpc.machines.list.queryOptions({}));
  const vm = useMemo(() => buildMSettingsVm(config.data ?? EMPTY_SNAPSHOT, cost.data), [config.data, cost.data]);
  const accounts = useMemo(() => auth.data ? buildAccountsVm(auth.data).summary
    : { claudeLoggedIn: false, piLoggedInCount: 0 }, [auth.data]);
  if (config.isLoading) return <SettingsMessage message={copy.title} />;
  if (config.isError) return <SettingsMessage message={`${copy.title}: ${config.error.message}`} failed />;
  return <MSettingsView vm={vm} copy={copy} connectionStatus={connectionStatus}
    accountsSummary={accounts} onlineMachines={onlineMachineCount(machines.data ?? [])}
    onBack={() => navigate('/m/project')} onOpenDaemon={() => navigate('/m/daemon')}
    onOpenSection={(section) => navigate(SECTION_PATH[section])} />;
}
