// input:  config snapshots, localized copy and shared cards
// output: platform identity primitives and MCP panel
// pos:    Shared badges and read-only MCP settings
// >>> Once updated, update this header and parent CORTEX.md <<<

import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { SCard } from './settings-ui';

const MONO = "'IBM Plex Mono',monospace";

// A green/gray "configured" pill derived HONESTLY from env presence (the prototype's
// "connected · socket mode" is live runtime state the contract does not expose).
export function PresencePill({ present }: { present: boolean }) {
  const L = useVocab();
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: 999,
        background: present ? 'var(--proto-success-bg)' : 'var(--proto-gray)',
        color: present ? 'var(--proto-success)' : 'var(--proto-muted-2)',
      }}
    >
      {present ? L.stConfigured : L.stNotConfigured}
    </span>
  );
}

export function PlatformAvatar({ glyph }: { glyph: string }) {
  return (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        background: 'var(--proto-gray)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        fontWeight: 700,
        color: 'var(--proto-muted)',
        flex: 'none',
      }}
    >
      {glyph}
    </span>
  );
}

export function McpPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const servers = snapshot.mcp?.servers ?? [];
  return (
    <SCard style={{ marginTop: 12, maxWidth: 760 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '11px 14px',
          borderBottom: '1px solid var(--proto-line-2)',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.stServers}</span>
        <div
          title="full / core / tui variant is a runtime-mode selection — no config.set for it (inert)"
          style={{ marginLeft: 'auto', display: 'flex', background: 'var(--proto-line-2)', borderRadius: 7, padding: 2 }}
        >
          {['full', 'core', 'tui'].map((v) => (
            <span
              key={v}
              style={{
                font: `500 10px ${MONO}`,
                color: v === 'full' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
                background: v === 'full' ? 'var(--proto-card)' : 'transparent',
                borderRadius: 5,
                padding: '3px 10px',
                boxShadow: v === 'full' ? 'var(--shadow-segment)' : 'none',
                cursor: 'not-allowed',
              }}
            >
              {v}
            </span>
          ))}
        </div>
      </div>
      {servers.length === 0 ? (
        <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--proto-muted-3)' }}>
          {L.stNoServers}
        </div>
      ) : (
        servers.map((name, i) => (
          <div
            key={name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              borderBottom: i < servers.length - 1 ? '1px solid var(--proto-alt)' : undefined,
            }}
          >
            <span style={{ font: `600 11.5px ${MONO}`, color: 'var(--proto-ink)' }}>{name}</span>
          </div>
        ))
      )}
      <div style={{ borderTop: '1px solid var(--proto-line-2)', padding: '8px 14px', fontSize: 10, color: 'var(--proto-faint)' }}>
        {L.stMcpFootNote}
      </div>
    </SCard>
  );
}
