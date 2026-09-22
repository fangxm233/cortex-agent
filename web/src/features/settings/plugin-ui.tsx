import type { CSSProperties, ReactNode } from 'react';
import type { UiPluginCatalogEntry, UiPluginMcpServer } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import { GROUP_STYLE, ROW_STYLE, SPill, SRow, SRowGroup, SSection } from './settings-ui';

const MONO = "'IBM Plex Mono',monospace";

// A plugin, a skill or an MCP server reads as one tile rather than a stack of hairline rows, so it
// takes the kit's ringed card and carries the row padding itself. `border: 0` is explicit because
// the tile is also used on a <button>, which would otherwise keep the UA border the ring replaced.
export const ROW: CSSProperties = { ...GROUP_STYLE, border: 0, padding: '13px 16px' };

export function pluginTitle(plugin: UiPluginCatalogEntry): string {
  return plugin.manifest.name ?? plugin.id;
}

export function joinValues(values: readonly string[], fallback = '—'): string {
  return values.length > 0 ? values.join(', ') : fallback;
}

export function pluginKindText(kind: UiPluginCatalogEntry['kind'], L: Vocab): string {
  if (kind === 'legacy') return L.plKindLegacy;
  if (kind === 'unknown') return L.plKindUnknown;
  return L.plKindPortable;
}

export function mcpStatusText(plugin: UiPluginCatalogEntry, L: Vocab): string {
  if (plugin.mcp.status === 'missing') return L.plMcpMissing;
  if (plugin.mcp.status === 'invalid') return L.plMcpInvalid;
  return L.plMcpValid;
}

export function mcpTransportText(server: UiPluginMcpServer, L: Vocab): string {
  if (server.type === 'sse') return L.plTransportSse;
  if (server.type === 'streamable-http') return L.plTransportHttp;
  return L.plTransportStdio;
}

export function manifestSourceText(source: UiPluginCatalogEntry['manifest']['source'], L: Vocab): string {
  if (source === 'legacy') return L.plManifestSourceLegacy;
  if (source === 'none') return L.plManifestSourceNone;
  return L.plManifestSourceRoot;
}

export function scopeNoticeText(plugin: UiPluginCatalogEntry, L: Vocab): string | null {
  if (plugin.scope === 'commission') return L.plScopeCommission;
  if (plugin.scope === 'channel') return L.plScopeChannel.replace('{prefix}', plugin.scopePrefix ?? '');
  return null;
}

/** One labelled fact, as a row of the meta card it sits in. */
export function MetaBlock({ label, value }: { label: string; value: string }) {
  return <SRow title={label} desc={value} />;
}

/** A named block of the detail pane: the sheet's uppercase heading over whatever follows. */
export function MetaSection({ label, children }: { label: string; children: ReactNode }) {
  return <SSection label={label}>{children}</SSection>;
}

export function EmptyMessage({ text, dataAttr }: { text: string; dataAttr: string }) {
  return <div {...{ [dataAttr]: '' }} style={{ fontSize: 12.5, color: 'var(--proto-muted-2)' }}>{text}</div>;
}

export function McpSummaryLine({ server }: { server: UiPluginMcpServer }) {
  const L = useVocab();
  const text = server.type === 'stdio'
    ? `${server.summary.command} · ${L.plArgsLabel} ${server.summary.argsCount} · ${L.plEnvLabel} ${joinValues(server.summary.envKeys)}`
    : `${server.summary.origin} · ${L.plHeadersLabel} ${joinValues(server.summary.headerKeys)}`;
  return (
    // Recessed, not raised: this tile always sits inside a card that already carries the fill.
    <div data-plugin-server={server.name} style={{
      display: 'flex', flexDirection: 'column', gap: 4, padding: '11px 14px',
      borderRadius: 'var(--r-control)', background: 'var(--proto-alt)',
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{server.name} · {mcpTransportText(server, L)}</div>
      {/* Wrapping, not ellipsed: this line is what an operator consents to when a server is added. */}
      <div style={{ font: `400 10.5px ${MONO}`, color: 'var(--proto-muted-3)', lineHeight: 1.6, wordBreak: 'break-word' }}>{text}</div>
    </div>
  );
}

export function McpServerSummary({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11.5, color: 'var(--proto-muted-2)' }}>{mcpStatusText(plugin, L)}</div>
      {plugin.mcp.servers.map((server) => <McpSummaryLine key={`${plugin.id}:${server.name}`} server={server} />)}
    </div>
  );
}

/** Advisory codes describe something the loader ignored, not something it refused. Painting them
 *  danger-red would re-create the very alarm the lenient validator exists to avoid. */
const ADVISORY_ISSUE_CODES = new Set(['skill_frontmatter_ignored']);

function IssueLine({ plugin, index }: { plugin: UiPluginCatalogEntry; index: number }) {
  const L = useVocab();
  const issue = plugin.issues[index];
  const advisory = ADVISORY_ISSUE_CODES.has(issue.code);
  const meta = [
    `${L.plIssueScopeLabel} ${issue.scope}`,
    `${L.plIssueCodeLabel} ${issue.code}`,
    `${L.plIssuePathLabel} ${issue.path ?? L.plUnknownValue}`,
  ].join(' · ');
  return (
    <div data-plugin-issue={advisory ? 'advisory' : 'error'}
      style={{ ...ROW_STYLE, flexDirection: 'column', alignItems: 'stretch', gap: 3 }}>
      <div style={{ font: `400 10.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>{meta}</div>
      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: advisory ? 'var(--proto-muted-2)' : 'var(--proto-danger)' }}>
        {issue.message}
      </div>
    </div>
  );
}

export function IssueList({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  if (plugin.issues.length === 0) return <div style={{ fontSize: 11.5, color: 'var(--proto-muted-2)' }}>{L.plNone}</div>;
  return (
    <SRowGroup>
      {plugin.issues.map((_, index) => <IssueLine key={`${plugin.id}:${index}`} plugin={plugin} index={index} />)}
    </SRowGroup>
  );
}

export function PluginBadges({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{pluginTitle(plugin)}</span>
      <SPill mono>{plugin.id}</SPill>
      <SPill mono>{plugin.manifest.version ?? L.plUnknownValue}</SPill>
      <SPill>{pluginKindText(plugin.kind, L)}</SPill>
      <SPill tone={plugin.valid ? 'success' : 'danger'}>{plugin.valid ? L.plValid : L.plInvalid}</SPill>
    </div>
  );
}
