// input:  public usage feature model, mobile UI kit, and local copy
// output: mobile quota, gateway spend, freshness, and refresh view
// pos:    Presentational mobile Usage settings view
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// @ds-adherence-ignore -- mobile v3 uses its dedicated scheme tokens and metrics
import type { ProviderUsageView, UsageView, UsageWindowView } from '@/features/usage';
import { MCard, MDrillHeader, MScrollBody, MC, MONO } from '@/mobile/ui/kit';

export interface MUsageCopy {
  title: string;
  refresh: string;
  refreshing: string;
  loading: string;
  loadError: string;
  refreshError: string;
  empty: string;
  quota: string;
  quotaUnsupported: string;
  neverObserved: string;
  unavailable: string;
  gatewaySpend: string;
  today: string;
  month: string;
  observed: string;
  ago: string;
  resetsIn: string;
  resetElapsed: string;
  freshness: Record<ProviderUsageView['freshness'], string>;
}

const META: React.CSSProperties = { font: `400 9.5px ${MONO}`, color: MC.muted };
const LABEL: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, color: MC.faint, textTransform: 'uppercase' };

function isoTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function FreshnessBadge({ provider, copy }: { provider: ProviderUsageView; copy: MUsageCopy }) {
  return (
    <span
      data-usage-freshness={provider.freshness}
      style={{ fontSize: 9.5, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: MC.runBg, color: MC.run }}
    >
      {copy.freshness[provider.freshness]}
    </span>
  );
}

function Observation({ provider, copy }: { provider: ProviderUsageView; copy: MUsageCopy }) {
  if (provider.observedAt === null || provider.observedAgo === null) return null;
  const timestamp = isoTime(provider.observedAt);
  return (
    <span style={META}>
      {copy.observed}{' '}
      <time dateTime={timestamp} title={timestamp}>{provider.observedAgo} {copy.ago}</time>
    </span>
  );
}

function WindowRow({ window, copy }: { window: UsageWindowView; copy: MUsageCopy }) {
  const reset = window.resetElapsed
    ? copy.resetElapsed
    : window.resetIn === null ? null : `${copy.resetsIn} ${window.resetIn}`;
  return (
    <div data-usage-window={window.type} style={{ padding: '9px 0', borderTop: `1px solid ${MC.divider}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: MC.sub }}>{window.label}</span>
        <span style={{ marginLeft: 'auto', font: `600 10px ${MONO}`, color: MC.ink }}>
          {window.utilizationLabel ?? copy.unavailable}
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden', marginTop: 6 }}>
        <div style={{ width: window.utilizationWidth, height: '100%', background: MC.run }} />
      </div>
      {reset ? <div style={{ ...META, marginTop: 5 }}>{reset}</div> : null}
    </div>
  );
}

function QuotaBlock({ provider, copy }: { provider: ProviderUsageView; copy: MUsageCopy }) {
  const unavailable = provider.quotaState === 'unsupported' ? copy.quotaUnsupported : copy.neverObserved;
  return (
    <section data-usage-quota={provider.provider} data-usage-quota-state={provider.quotaState} style={{ padding: '10px 13px' }}>
      <div style={LABEL}>{copy.quota}</div>
      {provider.quotaState === 'available'
        ? provider.windows.map(window => <WindowRow key={`${window.type}:${window.label}:${window.resetsAt ?? 'none'}`} window={window} copy={copy} />)
        : <div style={{ marginTop: 7, fontSize: 10.5, color: MC.muted }}>{unavailable}</div>}
    </section>
  );
}

function SpendBlock({ provider, copy }: { provider: ProviderUsageView; copy: MUsageCopy }) {
  if (!provider.spend) return null;
  return (
    <section data-usage-spend={provider.provider} style={{ borderTop: `1px solid ${MC.divider}`, padding: '10px 13px' }}>
      <div style={LABEL}>{copy.gatewaySpend}</div>
      <div style={{ display: 'flex', gap: 22, marginTop: 7 }}>
        <span style={{ font: `600 12px ${MONO}` }}>{provider.spend.today} <small>{copy.today}</small></span>
        <span style={{ font: `600 12px ${MONO}` }}>{provider.spend.month} <small>{copy.month}</small></span>
      </div>
    </section>
  );
}

function ProviderCard({ provider, copy }: { provider: ProviderUsageView; copy: MUsageCopy }) {
  return (
    <MCard padding={0}>
      <div data-usage-provider={provider.provider} style={{ padding: '11px 13px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 650, color: MC.ink }}>{provider.displayName}</span>
          <span style={{ marginLeft: 'auto' }}><FreshnessBadge provider={provider} copy={copy} /></span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
          <span style={META}>{provider.modes.join(' · ')}</span>
          <Observation provider={provider} copy={copy} />
        </div>
      </div>
      <QuotaBlock provider={provider} copy={copy} />
      <SpendBlock provider={provider} copy={copy} />
      {provider.note ? <div style={{ ...META, padding: '0 13px 10px' }}>{provider.note}</div> : null}
    </MCard>
  );
}

function ErrorFeedback({ label, error }: { label: string; error: { message: string } | null }) {
  if (!error) return null;
  return <div role="alert" style={{ color: MC.fail, fontSize: 10.5 }}>{label}: {error.message}</div>;
}

function RefreshButton({ copy, pending, onRefresh }: { copy: MUsageCopy; pending: boolean; onRefresh: () => void }) {
  return (
    <button
      type="button"
      data-usage-refresh
      aria-busy={pending}
      onClick={onRefresh}
      style={{ border: 0, borderRadius: 8, padding: '7px 10px', background: MC.runBg, color: MC.run, fontSize: 10.5, fontWeight: 650 }}
    >
      {pending ? copy.refreshing : copy.refresh}
    </button>
  );
}

interface MUsageViewProps {
  view: UsageView;
  copy: MUsageCopy;
  isLoading: boolean;
  queryError: { message: string } | null;
  refreshError: { message: string } | null;
  isRefreshing: boolean;
  onBack: () => void;
  onRefresh: () => void;
}

export function MUsageView({
  view, copy, isLoading, queryError, refreshError, isRefreshing, onBack, onRefresh,
}: MUsageViewProps) {
  const hasProviders = view.providers.length > 0;
  return (
    <>
      <MDrillHeader
        onBack={onBack}
        trailing={<RefreshButton copy={copy} pending={isRefreshing} onRefresh={onRefresh} />}
      >
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{copy.title}</div>
      </MDrillHeader>
      <MScrollBody gap={10}>
        {isLoading && !hasProviders ? <div style={{ color: MC.muted, fontSize: 12 }}>{copy.loading}</div> : null}
        <ErrorFeedback label={copy.loadError} error={queryError} />
        <ErrorFeedback label={copy.refreshError} error={refreshError} />
        {!isLoading && !queryError && !hasProviders ? <div style={{ color: MC.muted, fontSize: 12 }}>{copy.empty}</div> : null}
        {view.providers.map(provider => <ProviderCard key={provider.provider} provider={provider} copy={copy} />)}
      </MScrollBody>
    </>
  );
}
