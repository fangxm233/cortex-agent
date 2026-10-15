import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { useManualUpdateCheck } from '@/features/update-prompt/useManualUpdateCheck';
import { useMachinesResource } from '@/features/machines/useMachinesResource';
import { useConfigSnapshot } from '@/features/settings/controllers/useConfigSnapshot';
import type { SettingsSectionKey } from '@/features/settings/settings-nav';
import { onlineMachineCount } from './m-project-vm';
import { buildMSettingsVm } from './m-settings-vm';
import { MSettingsView } from './MSettingsView';

const EMPTY_SNAPSHOT: ConfigSnapshot = {
  budget: null, models: { default: null, favorites: [], memory: {} }, selectionDefault: null, machines: [], mcp: null,
  hooks: [], env: [], settings: [],
};

// Environments and plugins are edited on desktop only, so they have no mobile route.
const SECTION_PATH: Partial<Record<SettingsSectionKey, string>> = {
  appearance: '/m/settings/appearance', platform: '/m/settings/platform',
  accounts: '/m/settings/accounts', models: '/m/settings/models', budget: '/m/settings/budget',
  usage: '/m/settings/usage', machines: '/m/machines', mcp: '/m/settings/mcp',
  notifications: '/m/settings/notifications', hooks: '/m/settings/hooks', advanced: '/m/settings/advanced',
};

export function MSettingsScreen() {
  const navigate = useNavigate();
  const connectionStatus = useConnectionStatus();
  const config = useConfigSnapshot();
  const machines = useMachinesResource();
  const updates = useManualUpdateCheck();
  const vm = useMemo(() => buildMSettingsVm(config.data ?? EMPTY_SNAPSHOT), [config.data]);
  const openSection = (section: SettingsSectionKey) => {
    const path = SECTION_PATH[section];
    if (path) navigate(path);
  };
  return <MSettingsView vm={vm} connectionStatus={connectionStatus}
    onlineMachines={onlineMachineCount(machines.machines)}
    checkingUpdates={updates.busy} onCheckUpdates={() => void updates.check()}
    onBack={() => mobileHeaderBack(navigate, '/m/project')} onOpenDaemon={() => navigate('/m/daemon')}
    onOpenSection={openSection} />;
}
