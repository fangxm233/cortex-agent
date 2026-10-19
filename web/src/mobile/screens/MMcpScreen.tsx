import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useNavigate } from 'react-router-dom';
import { useVocab } from '@/i18n';
import { useConfigSnapshot } from '@/features/settings/controllers/useConfigSnapshot';
import { MSettingsQueryPage, MSettingsRow, MSettingsSection } from './MSettingsControls';

export function MMcpScreen() {
  const L = useVocab();
  const navigate = useNavigate();
  const config = useConfigSnapshot();
  return <MSettingsQueryPage title={L.stNavMcp} onBack={() => mobileHeaderBack(navigate, '/m/settings')} query={config}>
    {(snapshot) => {
      const servers = snapshot.mcp?.servers ?? [];
      return <MSettingsSection title={L.stServers}>
        {servers.length === 0
          ? <MSettingsRow title={L.stNoServers} />
          : servers.map((server) => <MSettingsRow key={server} title={server} />)}
      </MSettingsSection>;
    }}
  </MSettingsQueryPage>;
}
