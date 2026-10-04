import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { useManualUpdateCheck } from '@/features/update-prompt/useManualUpdateCheck';
import { useMachinesResource } from '@/features/machines/useMachinesResource';
import type { SettingsSectionKey } from '@/features/settings/settings-nav';
import { useTRPC } from '@/lib/trpc';
import { onlineMachineCount } from './m-project-vm';
import { buildMSettingsVm } from './m-settings-vm';
import { MSettingsView } from './MSettingsView';

const EMPTY_SNAPSHOT: ConfigSnapshot = {
  budget: null, profiles: null, machines: [], mcp: null,
  hooks: [], env: [], settings: [],
};

const SECTION_PATH: Record<SettingsSectionKey, string> = {
  appearance: '/m/settings/appearance', platform: '/m/settings/platform',
  accounts: '/m/settings/accounts', profiles: '/m/settings/profiles', budget: '/m/settings/budget',
  usage: '/m/settings/usage', machines: '/m/machines', environments: '/m/settings/environments',
  plugins: '/m/settings/plugins', mcp: '/m/settings/mcp', notifications: '/m/settings/notifications',
  hooks: '/m/settings/hooks', advanced: '/m/settings/advanced',
};

export function MSettingsScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const connectionStatus = useConnectionStatus();
  const config = useQuery(trpc.config.get.queryOptions({}));
  const machines = useMachinesResource();
  const updates = useManualUpdateCheck();
  const vm = useMemo(() => buildMSettingsVm(config.data ?? EMPTY_SNAPSHOT), [config.data]);
  return <MSettingsView vm={vm} connectionStatus={connectionStatus}
    onlineMachines={onlineMachineCount(machines.machines)}
    checkingUpdates={updates.busy} onCheckUpdates={() => void updates.check()}
    onBack={() => navigate('/m/project')} onOpenDaemon={() => navigate('/m/daemon')}
    onOpenSection={(section) => navigate(SECTION_PATH[section])} />;
}
