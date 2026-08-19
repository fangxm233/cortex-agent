// input:  public usage feature model, mobile UI kit, policy state, and local copy
// output: mobile quota, spend, refresh, and provider policy visibility/controls
// pos:    Presentational mobile Usage settings view
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// @ds-adherence-ignore -- mobile v3 uses its dedicated scheme tokens and metrics
import type { CSSProperties } from 'react';
import type { UsagePolicyControlsState, UsagePolicyDraft } from '@/features/usage';
import { policyActionState, usePolicyThresholdDraft } from '@/features/usage/usage-policy-controls';
import type { ProviderRateLimitView, ProviderUsageView, UsageView, UsageWindowView } from '@/features/usage';
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
  policy: {
    title: string;
    enabled: string;
    threshold: string;
    save: string;
    saving: string;
    resetDefault: string;
    defaultHint: string;
    futureHint: string;
  };
  freshness: Record<ProviderUsageView['freshness'], string>;
}

const META: CSSProperties = { font: `400 9.5px ${MONO}`, color: MC.muted };
const LABEL: CSSProperties = { fontSize: 9.5, fontWeight: 700, color: MC.faint, textTransform: 'uppercase' };
const POLICY_INPUT: CSSProperties = {
  width: 86,
  borderRadius: 8,
  border: `1px solid ${MC.divider}`,
  background: MC.card,
  color: MC.ink,
  font: `500 10px ${MONO}`,
  padding: '7px 22px 7px 8px',
  boxSizing: 'border-box',
};

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

function PolicyToggle(props: {
  provider: string;
  enabled: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={`Usage throttle ${props.provider}`}
      aria-checked={props.enabled}
      aria-disabled={props.disabled}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        border: 0,
        padding: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: props.enabled ? 'flex-end' : 'flex-start',
        background: props.enabled ? MC.run : MC.divider,
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.55 : 1,
      }}
    >
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: MC.card }} />
    </button>
  );
}

interface PolicyToggleRowProps {
  provider: string;
  policy: ProviderRateLimitView;
  copy: MUsageCopy;
  disabled: boolean;
  onSavePolicy: (provider: string, draft: UsagePolicyDraft) => void;
}

function PolicyToggleRow(props: PolicyToggleRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
      <PolicyToggle
        provider={props.provider}
        enabled={props.policy.enabled}
        disabled={props.disabled}
        onClick={() => props.onSavePolicy(props.provider, {
          enabled: !props.policy.enabled,
          thresholdPercent: props.policy.customThresholdPercent,
        })}
      />
      <span style={{ fontSize: 11, fontWeight: 600, color: MC.ink }}>{props.copy.policy.enabled}</span>
    </div>
  );
}

interface PolicyThresholdInputProps {
  provider: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function PolicyThresholdInput(props: PolicyThresholdInputProps) {
  return (
    <div style={{ position: 'relative', width: 86 }}>
      <input
        data-usage-threshold-input={props.provider}
        type="number"
        min={1}
        max={100}
        step="0.1"
        inputMode="decimal"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        style={{ ...POLICY_INPUT, opacity: props.disabled ? 0.55 : 1 }}
      />
      <span style={{ position: 'absolute', right: 8, top: 7, font: `500 10px ${MONO}`, color: MC.muted }}>%</span>
    </div>
  );
}

interface PolicyThresholdButtonProps {
  provider: string;
  disabled: boolean;
  label: string;
  onClick: () => void;
}

function PolicyThresholdSaveButton(props: PolicyThresholdButtonProps) {
  return (
    <button
      type="button"
      data-usage-threshold-save={props.provider}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        border: 0, borderRadius: 8, padding: '7px 10px', background: MC.runBg,
        color: MC.run, fontSize: 10.5, fontWeight: 650,
        opacity: props.disabled ? 0.45 : 1, cursor: props.disabled ? 'default' : 'pointer',
      }}
    >
      {props.label}
    </button>
  );
}

function PolicyThresholdResetButton(props: PolicyThresholdButtonProps) {
  return (
    <button
      type="button"
      data-usage-threshold-reset={props.provider}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        borderRadius: 8, border: `1px solid ${MC.divider}`, padding: '7px 10px',
        background: MC.card, color: MC.sub, fontSize: 10.5, fontWeight: 650,
        opacity: props.disabled ? 0.45 : 1, cursor: props.disabled ? 'default' : 'pointer',
      }}
    >
      {props.label}
    </button>
  );
}

interface PolicyThresholdRowProps {
  provider: string;
  policy: ProviderRateLimitView;
  copy: MUsageCopy;
  disabled: boolean;
  saveDisabled: boolean;
  resetDisabled: boolean;
  pending: boolean;
  draft: string;
  setDraft: (value: string) => void;
  parsedThreshold: number | null;
  onSavePolicy: (provider: string, draft: UsagePolicyDraft) => void;
}

function PolicyThresholdRow(props: PolicyThresholdRowProps) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={META}>{props.copy.policy.threshold}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <PolicyThresholdInput provider={props.provider} value={props.draft} disabled={props.disabled} onChange={props.setDraft} />
        <PolicyThresholdSaveButton
          provider={props.provider}
          disabled={props.saveDisabled}
          label={props.pending ? props.copy.policy.saving : props.copy.policy.save}
          onClick={() => props.parsedThreshold !== null && props.onSavePolicy(props.provider, {
            enabled: props.policy.enabled,
            thresholdPercent: props.parsedThreshold,
          })}
        />
        <PolicyThresholdResetButton
          provider={props.provider}
          disabled={props.resetDisabled}
          label={props.copy.policy.resetDefault}
          onClick={() => props.onSavePolicy(props.provider, {
            enabled: props.policy.enabled,
            thresholdPercent: null,
          })}
        />
      </div>
    </div>
  );
}

interface PolicyHintsProps {
  provider: string;
  error: { message: string } | null;
  copy: MUsageCopy;
}

function PolicyHints(props: PolicyHintsProps) {
  return (
    <>
      <div style={{ ...META, marginTop: 8 }}>{props.copy.policy.defaultHint}</div>
      <div style={{ ...META, marginTop: 3 }}>{props.copy.policy.futureHint}</div>
      {props.error ? <div data-usage-policy-error={props.provider} style={{ ...META, color: MC.fail, marginTop: 6 }}>{props.error.message}</div> : null}
    </>
  );
}

interface PolicyBlockProps {
  provider: ProviderUsageView;
  copy: MUsageCopy;
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (provider: string) => boolean;
  getPolicyError: (provider: string) => { message: string } | null;
  onSavePolicy: (provider: string, draft: UsagePolicyDraft) => void;
}

function PolicyBlock(props: PolicyBlockProps) {
  const policy = props.provider.rateLimitPolicy;
  if (!policy) return null;
  const providerName = props.provider.provider;
  const pending = props.isPolicySaving(providerName);
  const error = props.getPolicyError(providerName);
  const { draft, parsedThreshold, setDraft } = usePolicyThresholdDraft(policy);
  const state = policyActionState(props.policyControlsState !== 'ready', pending, parsedThreshold, policy.customThresholdPercent);
  return (
    <section data-usage-policy={providerName} style={{ borderTop: `1px solid ${MC.divider}`, padding: '10px 13px' }}>
      <div style={LABEL}>{props.copy.policy.title}</div>
      <PolicyToggleRow provider={providerName} policy={policy} copy={props.copy} disabled={state.disabled} onSavePolicy={props.onSavePolicy} />
      <PolicyThresholdRow
        provider={providerName}
        policy={policy}
        copy={props.copy}
        disabled={state.disabled}
        saveDisabled={state.saveDisabled}
        resetDisabled={state.resetDisabled}
        pending={pending}
        draft={draft}
        setDraft={setDraft}
        parsedThreshold={parsedThreshold}
        onSavePolicy={props.onSavePolicy}
      />
      <PolicyHints provider={providerName} error={error} copy={props.copy} />
    </section>
  );
}

function ProviderCard(props: {
  provider: ProviderUsageView;
  copy: MUsageCopy;
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (provider: string) => boolean;
  getPolicyError: (provider: string) => { message: string } | null;
  onSavePolicy: (provider: string, draft: UsagePolicyDraft) => void;
}) {
  const { provider, copy } = props;
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
      <PolicyBlock
        provider={provider}
        copy={copy}
        policyControlsState={props.policyControlsState}
        isPolicySaving={props.isPolicySaving}
        getPolicyError={props.getPolicyError}
        onSavePolicy={props.onSavePolicy}
      />
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
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (provider: string) => boolean;
  getPolicyError: (provider: string) => { message: string } | null;
  onBack: () => void;
  onRefresh: () => void;
  onSavePolicy: (provider: string, draft: UsagePolicyDraft) => void;
}

export function MUsageView({
  view,
  copy,
  isLoading,
  queryError,
  refreshError,
  isRefreshing,
  policyControlsState,
  isPolicySaving,
  getPolicyError,
  onBack,
  onRefresh,
  onSavePolicy,
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
        {view.providers.map(provider => (
          <ProviderCard
            key={provider.provider}
            provider={provider}
            copy={copy}
            policyControlsState={policyControlsState}
            isPolicySaving={isPolicySaving}
            getPolicyError={getPolicyError}
            onSavePolicy={onSavePolicy}
          />
        ))}
      </MScrollBody>
    </>
  );
}
