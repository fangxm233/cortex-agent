import { useNavigate } from 'react-router-dom';
import { useVocab } from '@/i18n';
import { useConfigSnapshot } from '@/features/settings/controllers/useConfigSnapshot';
import { MSettingsCard, MSettingsQueryPage, MSettingsRow } from './MSettingsControls';

export function MMcpScreen() {
  const L = useVocab();
  const navigate = useNavigate();
  const config = useConfigSnapshot();
  return <MSettingsQueryPage title={L.stNavMcp} onBack={() => navigate('/m/settings')} query={config}>
    {(snapshot) => {
      const servers = snapshot.mcp?.servers ?? [];
      return <MSettingsCard title={L.stServers}>
        {servers.length === 0
          ? <MSettingsRow title={L.stNoServers} last />
          : servers.map((server, index) => <MSettingsRow key={server} title={server}
            last={index === servers.length - 1} />)}
      </MSettingsCard>;
    }}
  </MSettingsQueryPage>;
}
