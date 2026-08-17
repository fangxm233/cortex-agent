// input:  shared usage hook, provider usage view, and localized copy
// output: desktop Settings Usage quota and gateway-spend cards
// pos:    Independently queried desktop usage settings panel
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { UsageFreshness } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import { SButton, SCard, SCardHeader } from '@/features/settings/settings-ui';
import { useUsage } from './useUsage';
import type { ProviderUsageView, UsageWindowView } from './usage-vm';

const MONO = "'IBM Plex Mono',monospace";

const FRESHNESS_KEYS: Record<UsageFreshness, keyof Vocab> = {
  live: 'usageFreshLive',
  stale: 'usageFreshStale',
  never: 'usageFreshNever',
  unsupported: 'usageFreshUnsupported',
};

function isoTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function FreshnessBadge({ freshness }: { freshness: UsageFreshness }) {
  const L = useVocab();
  return (
    <span data-usage-freshness={freshness} style={{ padding: '2px 7px', borderRadius: 999, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' }}>
      {L[FRESHNESS_KEYS[freshness]]}
    </span>
  );
}

function Observation({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  if (provider.observedAt === null || provider.observedAgo === null) return null;
  return (
    <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>
      {L.usageObserved}{' '}
      <time dateTime={isoTime(provider.observedAt)} title={isoTime(provider.observedAt)}>{provider.observedAgo} {L.usageAgo}</time>
    </span>
  );
}

function UsageProgress({ window }: { window: UsageWindowView }) {
  return (
    <div style={{ height: 5, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden', marginTop: 6 }}>
      <div style={{ width: window.utilizationWidth, height: '100%', background: 'var(--proto-accent)' }} />
    </div>
  );
}

function WindowRow({ window }: { window: UsageWindowView }) {
  const L = useVocab();
  return (
    <div data-usage-window={window.type} style={{ padding: '9px 0', borderTop: '1px solid var(--proto-line-2)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-ink-2)' }}>{window.label}</span>
        <span style={{ marginLeft: 'auto', font: `600 10px ${MONO}`, color: 'var(--proto-ink)' }}>{window.utilizationLabel ?? L.usageUnavailable}</span>
      </div>
      <UsageProgress window={window} />
      {window.resetElapsed ? (
        <div style={{ marginTop: 5, font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>
          {L.usageResetElapsed}
        </div>
      ) : window.resetsAt !== null && window.resetIn !== null ? (
        <div style={{ marginTop: 5, font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>
          {L.usageResetsIn}{' '}<time dateTime={isoTime(window.resetsAt)} title={isoTime(window.resetsAt)}>{window.resetIn}</time>
        </div>
      ) : null}
    </div>
  );
}

function QuotaBlock({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  const stateCopy = provider.quotaState === 'unsupported'
    ? L.usageQuotaUnsupported
    : L.usageNeverObserved;
  return (
    <section data-usage-quota={provider.provider} data-usage-quota-state={provider.quotaState} style={{ padding: '10px 14px' }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--proto-muted-3)', textTransform: 'uppercase' }}>{L.usageQuota}</div>
      {provider.quotaState === 'available'
        ? provider.windows.map(window => <WindowRow key={`${window.type}:${window.resetsAt ?? 'none'}`} window={window} />)
        : <div style={{ marginTop: 7, fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{stateCopy}</div>}
    </section>
  );
}

function SpendBlock({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  if (!provider.spend) return null;
  return (
    <section data-usage-spend={provider.provider} style={{ borderTop: '1px solid var(--proto-line-2)', padding: '10px 14px' }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--proto-muted-3)', textTransform: 'uppercase' }}>{L.usageGatewaySpend}</div>
      <div style={{ display: 'flex', gap: 24, marginTop: 7 }}>
        <span style={{ font: `600 12px ${MONO}` }}>{provider.spend.today} <small>{L.usageToday}</small></span>
        <span style={{ font: `600 12px ${MONO}` }}>{provider.spend.month} <small>{L.usageMonth}</small></span>
      </div>
    </section>
  );
}

function ProviderCard({ provider }: { provider: ProviderUsageView }) {
  return (
    <SCard style={{ marginTop: 12, maxWidth: 980 }}>
      <SCardHeader title={provider.displayName} right={<FreshnessBadge freshness={provider.freshness} />} />
      <div style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>{provider.modes.join(' · ')}</span>
        <Observation provider={provider} />
      </div>
      <QuotaBlock provider={provider} />
      <SpendBlock provider={provider} />
      {provider.note ? <div style={{ padding: '0 14px 10px', fontSize: 9.5, color: 'var(--proto-muted-3)' }}>{provider.note}</div> : null}
    </SCard>
  );
}

export function UsagePanel() {
  const L = useVocab();
  const usage = useUsage();
  if (usage.isLoading) return <div style={{ marginTop: 16, fontSize: 12, color: 'var(--proto-muted-3)' }}>{L.usageLoading}</div>;
  if (usage.queryError) return <div style={{ marginTop: 16, color: 'var(--proto-danger)' }}>{L.usageLoadError}: {usage.queryError.message}</div>;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SButton tone="accent" data-usage-refresh disabled={usage.isRefreshing} onClick={usage.refresh}>
          {usage.isRefreshing ? L.usageRefreshing : L.usageRefresh}
        </SButton>
        {usage.refreshError ? <span style={{ color: 'var(--proto-danger)', fontSize: 10.5 }}>{L.usageRefreshError}: {usage.refreshError.message}</span> : null}
      </div>
      {usage.view.providers.length === 0 ? <div style={{ marginTop: 16, color: 'var(--proto-muted-3)' }}>{L.usageEmpty}</div> : null}
      {usage.view.providers.map(provider => <ProviderCard key={provider.provider} provider={provider} />)}
    </div>
  );
}
