// input:  config snapshots, localized copy and shared cards
// output: platform identity primitives and MCP panel
// pos:    Shared badges and read-only MCP settings
// >>> Once updated, update this header and parent AGENTS.md <<<

import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { SCard, SCardHeader, SPill, SRow, SSegmented, type SegmentOption } from './settings-ui';

const MONO = "'IBM Plex Mono',monospace";

// A green/gray "configured" pill derived HONESTLY from env presence (the prototype's
// "connected · socket mode" is live runtime state the contract does not expose).
export function PresencePill({ present }: { present: boolean }) {
  const L = useVocab();
  return (
    <SPill tone={present ? 'success' : 'neutral'}>
      {present ? L.stConfigured : L.stNotConfigured}
    </SPill>
  );
}

export function PlatformAvatar({ glyph }: { glyph: string }) {
  return (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: 'var(--r-chip)',
        background: 'var(--proto-gray)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10.5,
        fontWeight: 700,
        color: 'var(--proto-muted)',
        flex: 'none',
      }}
    >
      {glyph}
    </span>
  );
}

type McpVariant = 'full' | 'core' | 'tui';

const MCP_VARIANTS: SegmentOption<McpVariant>[] = [
  { id: 'full', label: 'full' },
  { id: 'core', label: 'core' },
  { id: 'tui', label: 'tui' },
];

// No `onChange`: the variant is chosen by the runtime that started the server, so the segment
// reports the shape of that choice without offering to write it.
function VariantSegment() {
  return (
    <span
      title="full / core / tui variant is a runtime-mode selection — no config.set for it (inert)"
      style={{ display: 'inline-flex' }}
    >
      <SSegmented value="full" options={MCP_VARIANTS} mono />
    </span>
  );
}

function ServerRows({ servers }: { servers: string[] }) {
  const L = useVocab();
  if (servers.length === 0) {
    return <SRow title={<span style={{ color: 'var(--proto-muted-3)' }}>{L.stNoServers}</span>} />;
  }
  return (
    <>
      {servers.map((name, index) => (
        <div key={name} style={index < servers.length - 1 ? { borderBottom: '1px solid var(--proto-line-2)' } : undefined}>
          <SRow title={<span style={{ font: `600 12.5px ${MONO}` }}>{name}</span>} />
        </div>
      ))}
    </>
  );
}

export function McpPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const servers = snapshot.mcp?.servers ?? [];
  return (
    <SCard style={{ overflow: 'hidden' }}>
      <SCardHeader title={L.stServers} right={<VariantSegment />} />
      <ServerRows servers={servers} />
      <div style={{
        borderTop: '1px solid var(--proto-line-2)', padding: '12px 16px',
        fontSize: 11.5, lineHeight: 1.6, color: 'var(--proto-muted-2)',
      }}>
        {L.stMcpFootNote}
      </div>
    </SCard>
  );
}
