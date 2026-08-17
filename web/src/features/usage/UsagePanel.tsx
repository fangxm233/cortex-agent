// input:  shared usage hook, provider usage view, and localized copy
// output: desktop Settings Usage cards with meters, live badge, and spend tiles
// pos:    Independently queried desktop usage settings panel
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { CSSProperties, ReactNode } from 'react';
import { useVocab } from '@/i18n';
import { SButton, SCard } from '@/features/settings/settings-ui';
import { useUsage } from './useUsage';
import type { ProviderUsageView, UsageSeverity, UsageWindowView } from './usage-vm';

const MONO = "'IBM Plex Mono',monospace";

// Meter fill escalates with utilization; the track stays neutral in both themes.
const SEVERITY_FILL: Record<UsageSeverity, string> = {
  normal: 'var(--proto-accent)',
  warning: 'var(--proto-amber)',
  danger: 'var(--proto-danger)',
};

const SECTION_LABEL: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '.07em',
  color: 'var(--proto-muted-3)',
  textTransform: 'uppercase',
};

const META_TEXT: CSSProperties = { font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' };

function isoTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

// Staleness is already conveyed by the observed-ago line; only live earns a badge.
function LiveBadge() {
  const L = useVocab();
  return (
    <span
      data-usage-freshness="live"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px',
        borderRadius: 999, background: 'var(--pill-done-bg)', color: 'var(--pill-done-fg)',
        font: `600 9.5px ${MONO}`,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', flex: 'none' }} />
      {L.usageFreshLive}
    </span>
  );
}

function Observation({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  if (provider.observedAt === null || provider.observedAgo === null) return null;
  return (
    <span style={META_TEXT}>
      {L.usageObserved}{' '}
      <time dateTime={isoTime(provider.observedAt)} title={isoTime(provider.observedAt)}>{provider.observedAgo} {L.usageAgo}</time>
    </span>
  );
}

function CardHeader({ provider }: { provider: ProviderUsageView }) {
  return (
    <header style={{ padding: '11px 14px 10px', borderBottom: '1px solid var(--proto-line-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--proto-ink)' }}>{provider.displayName}</span>
        {provider.freshness === 'live' ? <span style={{ marginLeft: 'auto' }}><LiveBadge /></span> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <span style={META_TEXT}>{provider.modes.join(' · ')}</span>
        <Observation provider={provider} />
      </div>
    </header>
  );
}

function UsageMeter({ window }: { window: UsageWindowView }) {
  return (
    <div style={{ height: 8, borderRadius: 999, background: 'var(--proto-gray)', overflow: 'hidden', marginTop: 6 }}>
      <div
        style={{
          width: window.utilizationWidth, height: '100%', borderRadius: 999,
          background: SEVERITY_FILL[window.severity],
        }}
      />
    </div>
  );
}

function ResetLine({ window }: { window: UsageWindowView }) {
  const L = useVocab();
  if (window.resetElapsed) return <div style={{ ...META_TEXT, marginTop: 4 }}>{L.usageResetElapsed}</div>;
  if (window.resetsAt === null || window.resetIn === null) return null;
  return (
    <div style={{ ...META_TEXT, marginTop: 4 }}>
      {L.usageResetsIn}{' '}<time dateTime={isoTime(window.resetsAt)} title={isoTime(window.resetsAt)}>{window.resetIn}</time>
    </div>
  );
}

function WindowRow({ window }: { window: UsageWindowView }) {
  const L = useVocab();
  return (
    <div data-usage-window={window.type} data-usage-severity={window.severity} style={{ marginTop: 11 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-ink-2)' }}>{window.label}</span>
        {window.utilizationLabel !== null
          ? <span style={{ marginLeft: 'auto', font: `600 14px ${MONO}`, color: 'var(--proto-ink)', letterSpacing: '-.02em' }}>{window.utilizationLabel}</span>
          : <span style={{ marginLeft: 'auto', font: `500 10px ${MONO}`, color: 'var(--proto-muted-2)' }}>{L.usageUnavailable}</span>}
      </div>
      <UsageMeter window={window} />
      <ResetLine window={window} />
    </div>
  );
}

function QuietState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: 8, border: '1px dashed var(--proto-line-3)', borderRadius: 8,
        padding: '8px 11px', fontSize: 10.5, lineHeight: 1.55, color: 'var(--proto-muted-2)',
      }}
    >
      {children}
    </div>
  );
}

// Unsupported providers show only spend; never keeps its short empty state.
function QuotaBlock({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  if (provider.quotaState === 'unsupported') return null;
  return (
    <section data-usage-quota={provider.provider} data-usage-quota-state={provider.quotaState} style={{ padding: '10px 14px 13px', flex: 1 }}>
      <div style={SECTION_LABEL}>{L.usageQuota}</div>
      {provider.quotaState === 'available'
        ? provider.windows.map(window => <WindowRow key={`${window.type}:${window.label}:${window.resetsAt ?? 'none'}`} window={window} />)
        : <QuietState>{L.usageNeverObserved}</QuietState>}
    </section>
  );
}

function SpendTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--proto-alt)', border: '1px solid var(--proto-line-2)', borderRadius: 8, padding: '7px 10px' }}>
      <div style={{ ...SECTION_LABEL, letterSpacing: '.05em' }}>{label}</div>
      <div style={{ font: `600 15px ${MONO}`, color: 'var(--proto-ink)', letterSpacing: '-.02em', marginTop: 3 }}>{value}</div>
    </div>
  );
}

function SpendBlock({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  if (!provider.spend) return null;
  return (
    <section data-usage-spend={provider.provider} style={{ borderTop: '1px solid var(--proto-line-2)', padding: '10px 14px 12px' }}>
      <div style={SECTION_LABEL}>{L.usageGatewaySpend}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 7 }}>
        <SpendTile label={L.usageToday} value={provider.spend.today} />
        <SpendTile label={L.usageMonth} value={provider.spend.month} />
      </div>
    </section>
  );
}

// Info-tone notes never render on desktop; only failures earn a banner.
function NoteBlock({ provider }: { provider: ProviderUsageView }) {
  if (!provider.note || provider.noteTone !== 'error') return null;
  return (
    <div
      data-usage-note="error"
      style={{
        margin: '0 14px 12px', display: 'flex', alignItems: 'flex-start', gap: 7,
        background: 'var(--proto-danger-bg)', borderRadius: 8, padding: '7px 10px',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-danger)', flex: 'none', marginTop: 4 }} />
      <span style={{ fontSize: 10, lineHeight: 1.5, color: 'var(--proto-danger)' }}>{provider.note}</span>
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderUsageView }) {
  return (
    <SCard style={{ display: 'flex', flexDirection: 'column' }}>
      <CardHeader provider={provider} />
      <QuotaBlock provider={provider} />
      <SpendBlock provider={provider} />
      <NoteBlock provider={provider} />
    </SCard>
  );
}

function ErrorChip({ label, message }: { label: string; message: string }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--proto-danger-bg)',
        borderRadius: 8, padding: '5px 10px', color: 'var(--proto-danger)', fontSize: 10.5,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-danger)', flex: 'none' }} />
      {label}: {message}
    </span>
  );
}

// Circular-arrows glyph; the SMIL rotation runs only while a refresh is pending.
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flex: 'none', display: 'block' }}
    >
      <g>
        {spinning
          ? <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
          : null}
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
        <path d="M8 16H3v5" />
      </g>
    </svg>
  );
}

// Right-aligned toolbar; the button stays clickable while a refresh is pending.
function RefreshToolbar({ usage }: { usage: ReturnType<typeof useUsage> }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
      {usage.refreshError
        ? (
          <span style={{ fontSize: 10, color: 'var(--proto-danger)' }}>
            {L.usageRefreshError}: {usage.refreshError.message}
          </span>
        )
        : null}
      <SButton tone="neutral" data-usage-refresh aria-busy={usage.isRefreshing} onClick={usage.refresh}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshIcon spinning={usage.isRefreshing} />
          {usage.isRefreshing ? L.usageRefreshing : L.usageRefresh}
        </span>
      </SButton>
    </div>
  );
}

export function UsagePanel() {
  const L = useVocab();
  const usage = useUsage();
  if (usage.isLoading) return <div style={{ marginTop: 16, fontSize: 12, color: 'var(--proto-muted-3)' }}>{L.usageLoading}</div>;
  if (usage.queryError) {
    return <div style={{ marginTop: 16 }}><ErrorChip label={L.usageLoadError} message={usage.queryError.message} /></div>;
  }
  return (
    <div style={{ marginTop: 12, maxWidth: 980 }}>
      <RefreshToolbar usage={usage} />
      {usage.view.providers.length === 0
        ? <div style={{ marginTop: 14, maxWidth: 420 }}><QuietState>{L.usageEmpty}</QuietState></div>
        : (
          <div
            style={{
              marginTop: 12, display: 'grid', gap: 12, alignItems: 'start',
              gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
            }}
          >
            {usage.view.providers.map(provider => <ProviderCard key={provider.provider} provider={provider} />)}
          </div>
        )}
    </div>
  );
}
