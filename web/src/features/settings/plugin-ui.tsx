// input:  sanitized plugin catalog DTOs and vocab
// output: shared plugin styles, labels, and read-only presentation pieces
// pos:    Presentational primitives shared by the plugins page and the assignment control
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { CSSProperties, ReactNode } from 'react';
import type { UiPluginCatalogEntry, UiPluginMcpServer } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';

export const META_LABEL: CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em',
  color: 'var(--proto-muted-3)', textTransform: 'uppercase',
};
export const NOTICE: CSSProperties = {
  fontSize: 10.5, color: 'var(--proto-muted-2)', background: 'var(--proto-alt)',
  border: '1px solid var(--proto-line)', borderRadius: 8, padding: '8px 10px',
};
export const ROW: CSSProperties = {
  border: '1px solid var(--proto-line)', borderRadius: 9,
  padding: '10px 12px', background: 'var(--proto-card)',
};
export const PILL: CSSProperties = {
  border: '1px solid var(--proto-line)', borderRadius: 999,
  padding: '2px 8px', fontSize: 10, color: 'var(--proto-muted-2)',
};
export const SCROLLER: CSSProperties = {
  flex: 1, overflow: 'auto', minHeight: 0, maxHeight: '100%',
  padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10,
};

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

export function MetaBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={META_LABEL}>{label}</div>
      <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 4 }}>{value}</div>
    </div>
  );
}

export function MetaSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={META_LABEL}>{label}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

export function EmptyMessage({ text, dataAttr }: { text: string; dataAttr: string }) {
  return <div {...{ [dataAttr]: '' }} style={{ fontSize: 11, color: 'var(--proto-muted-2)' }}>{text}</div>;
}

export function McpSummaryLine({ server }: { server: UiPluginMcpServer }) {
  const L = useVocab();
  const text = server.type === 'stdio'
    ? `${server.summary.command} · ${L.plArgsLabel} ${server.summary.argsCount} · ${L.plEnvLabel} ${joinValues(server.summary.envKeys)}`
    : `${server.summary.origin} · ${L.plHeadersLabel} ${joinValues(server.summary.headerKeys)}`;
  return (
    <div data-plugin-server={server.name} style={NOTICE}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{server.name} · {mcpTransportText(server, L)}</div>
      <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{text}</div>
    </div>
  );
}

export function McpServerSummary({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{mcpStatusText(plugin, L)}</div>
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
    <div data-plugin-issue={advisory ? 'advisory' : 'error'} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 10, color: 'var(--proto-muted-2)' }}>{meta}</div>
      <div style={{ fontSize: 10.5, color: advisory ? 'var(--proto-muted-2)' : 'var(--proto-danger)' }}>{issue.message}</div>
    </div>
  );
}

export function IssueList({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  if (plugin.issues.length === 0) return <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{L.plNone}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {plugin.issues.map((_, index) => <IssueLine key={`${plugin.id}:${index}`} plugin={plugin} index={index} />)}
    </div>
  );
}

export function PluginBadges({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{pluginTitle(plugin)}</span>
      <span style={PILL}>{plugin.id}</span>
      <span style={PILL}>{plugin.manifest.version ?? L.plUnknownValue}</span>
      <span style={PILL}>{pluginKindText(plugin.kind, L)}</span>
      <span style={PILL}>{plugin.valid ? L.plValid : L.plInvalid}</span>
    </div>
  );
}
