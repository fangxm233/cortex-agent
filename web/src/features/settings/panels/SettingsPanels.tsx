import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { SRow, SRowGroup, SSection, SStatus } from '@/features/settings/ui/settings-ui';

// "Configured" derived HONESTLY from env presence (the prototype's "connected · socket mode" is
// live runtime state the contract does not expose).
export function PresenceStatus({ present }: { present: boolean }) {
  const L = useVocab();
  return (
    <SStatus data-presence={present ? 'configured' : 'missing'} tone={present ? 'success' : 'neutral'}>
      {present ? L.stConfigured : L.stNotConfigured}
    </SStatus>
  );
}

function ServerRows({ servers }: { servers: string[] }) {
  const L = useVocab();
  if (servers.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--proto-muted-2)' }}>{L.stNoServers}</div>;
  }
  return (
    <SRowGroup>
      {servers.map((name) => <SRow key={name} title={<span style={{ overflowWrap: 'anywhere' }}>{name}</span>} />)}
    </SRowGroup>
  );
}

export function McpPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const servers = snapshot.mcp?.servers ?? [];
  return (
    <SSection label={L.stServers} action={servers.length > 0 ? String(servers.length) : undefined}>
      <ServerRows servers={servers} />
    </SSection>
  );
}
