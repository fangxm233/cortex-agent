// input:  config.get MCP server summary
// output: read-only mobile MCP server list
// pos:    Mobile MCP settings screen
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { MC } from '@/mobile/ui/kit';
import { MSettingsCard, MSettingsPage, MSettingsRow } from './MSettingsControls';

export function MMcpScreen() {
  const L = useVocab();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const query = useQuery(trpc.config.get.queryOptions({}));
  const servers = query.data?.mcp?.servers ?? [];
  if (query.isLoading) return <MSettingsPage title={L.stNavMcp} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13 }}>{L.stLoadingConfig}</div></MSettingsCard>
  </MSettingsPage>;
  if (query.isError) return <MSettingsPage title={L.stNavMcp} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13, color: MC.fail }}>{L.stFailedLoadConfig}</div></MSettingsCard>
  </MSettingsPage>;
  return <MSettingsPage title={L.stNavMcp} onBack={() => navigate('/m/settings')}>
    <MSettingsCard title={L.stServers} note={L.stMcpFootNote}>
      {servers.length === 0
        ? <MSettingsRow title={L.stNoServers} last />
        : servers.map((server, index) => <MSettingsRow key={server} title={server}
          last={index === servers.length - 1} />)}
    </MSettingsCard>
  </MSettingsPage>;
}
