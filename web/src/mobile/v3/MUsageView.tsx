// input:  public usage feature model, mobile UI kit, row policy state, and local copy
// output: mobile quota, spend, refresh, row controls, and legacy fallback notice
// pos:    Presentational mobile Usage settings view
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// @ds-adherence-ignore -- mobile v3 uses its dedicated scheme tokens and metrics
import type { CSSProperties } from 'react';
import type {
  ProviderLegacyFallbackView,
  UsagePolicyControlsState,
  UsagePolicyDraft,
  UsagePolicyTarget,
  ProviderUsageView,
  UsageView,
  UsageWindowPolicyView,
  UsageWindowView,
} from '@/features/usage';
import { usagePolicyTargetKey } from '@/features/usage';
import { policyActionState, usePolicyThresholdDraft } from '@/features/usage/usage-policy-controls';
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
    enabled: string;
    disabled: string;
    threshold: string;
    save: string;
    saving: string;
    resetDefault: string;
    futureHint: string;
    defaultPrefix: string;
    legacyFallbackTitle: string;
    legacyFallbackBody: string;
    clearLegacy: string;
    usingLegacy: string;
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

function targetKey(target: UsagePolicyTarget): string {
  return usagePolicyTargetKey(target);
}

function summaryText(policy: UsageWindowPolicyView, copy: MUsageCopy): string {
  const base = `${copy.policy.defaultPrefix} ${policy.defaultThresholdPercent}%`;
  return policy.usesLegacyFallback ? `${base} · ${copy.policy.usingLegacy}` : base;
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
      {copy.observed}{' '}<time dateTime={timestamp} title={timestamp}>{provider.observedAgo} {copy.ago}</time>
    </span>
  );
}

function PolicyToggle(props: {
  target: UsagePolicyTarget;
  enabled: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={`Usage throttle ${targetKey(props.target)}`}
      aria-checked={props.enabled}
      aria-disabled={props.disabled}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        width: 38, height: 22, borderRadius: 999, border: 0, padding: 2,
        display: 'flex', alignItems: 'center', justifyContent: props.enabled ? 'flex-end' : 'flex-start',
        background: props.enabled ? MC.run : MC.divider, cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.55 : 1,
      }}
    >
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: MC.card }} />
    </button>
  );
}

function PolicyThresholdInput(props: {
  target: UsagePolicyTarget;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ position: 'relative', width: 86 }}>
      <input
        data-usage-threshold-input={targetKey(props.target)}
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

interface PolicyThresholdButtonsProps {
  policy: UsageWindowPolicyView;
  saveDisabled: boolean;
  resetDisabled: boolean;
  pending: boolean;
  parsedThreshold: number | null;
  copy: MUsageCopy;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}

function PolicySaveButton(props: PolicyThresholdButtonsProps) {
  return (
    <button
      type="button" data-usage-threshold-save={targetKey(props.policy.target)} disabled={props.saveDisabled}
      onClick={() => props.parsedThreshold !== null && props.onSavePolicy(props.policy.target, {
        enabled: props.policy.enabled, thresholdPercent: props.parsedThreshold,
      })}
      style={{
        border: 0, borderRadius: 8, padding: '7px 10px', background: MC.runBg,
        color: MC.run, fontSize: 10.5, fontWeight: 650,
        opacity: props.saveDisabled ? 0.45 : 1, cursor: props.saveDisabled ? 'default' : 'pointer',
      }}
    >
      {props.pending ? props.copy.policy.saving : props.copy.policy.save}
    </button>
  );
}

function PolicyResetButton(props: PolicyThresholdButtonsProps) {
  return (
    <button
      type="button" data-usage-threshold-reset={targetKey(props.policy.target)} disabled={props.resetDisabled}
      onClick={() => props.onSavePolicy(props.policy.target, { enabled: true, thresholdPercent: null })}
      style={{
        borderRadius: 8, border: `1px solid ${MC.divider}`, padding: '7px 10px',
        background: MC.card, color: MC.sub, fontSize: 10.5, fontWeight: 650,
        opacity: props.resetDisabled ? 0.45 : 1, cursor: props.resetDisabled ? 'default' : 'pointer',
      }}
    >
      {props.copy.policy.resetDefault}
    </button>
  );
}

function PolicyThresholdButtons(props: PolicyThresholdButtonsProps) {
  return <><PolicySaveButton {...props} /><PolicyResetButton {...props} /></>;
}

interface WindowPolicyBlockProps {
  policy: UsageWindowPolicyView;
  copy: MUsageCopy;
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (target: UsagePolicyTarget) => boolean;
  getPolicyError: (target: UsagePolicyTarget) => { message: string } | null;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}

function PolicyToggleRow(props: WindowPolicyBlockProps & { disabled: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
      <PolicyToggle
        target={props.policy.target} enabled={props.policy.enabled} disabled={props.disabled}
        onClick={() => props.onSavePolicy(props.policy.target, {
          enabled: !props.policy.enabled, thresholdPercent: props.policy.thresholdPercent,
        })}
      />
      <span style={{ fontSize: 11, fontWeight: 600, color: MC.ink }}>{props.copy.policy.enabled}</span>
    </div>
  );
}

function PolicyThresholdRow(props: PolicyThresholdButtonsProps & {
  draft: string; disabled: boolean; setDraft: (value: string) => void;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={META}>{props.copy.policy.threshold}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <PolicyThresholdInput target={props.policy.target} value={props.draft} disabled={props.disabled} onChange={props.setDraft} />
        <PolicyThresholdButtons {...props} />
      </div>
    </div>
  );
}

function WindowPolicyBlock(props: WindowPolicyBlockProps) {
  const pending = props.isPolicySaving(props.policy.target);
  const error = props.getPolicyError(props.policy.target);
  const { draft, parsedThreshold, setDraft } = usePolicyThresholdDraft(props.policy);
  const state = policyActionState(props.policyControlsState !== 'ready', pending, parsedThreshold, props.policy);
  const buttonProps = {
    policy: props.policy, pending, parsedThreshold, copy: props.copy,
    saveDisabled: state.saveDisabled, resetDisabled: state.resetDisabled,
    onSavePolicy: props.onSavePolicy,
  };
  return (
    <div
      data-usage-policy-row={targetKey(props.policy.target)} data-usage-policy-provider={props.policy.target.provider}
      data-usage-policy-window-type={props.policy.target.windowType ?? ''} data-usage-policy-window-label={props.policy.target.windowLabel ?? ''}
      style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${MC.divider}` }}
    >
      <div style={META}>{summaryText(props.policy, props.copy)}</div>
      <PolicyToggleRow {...props} disabled={state.disabled} />
      <PolicyThresholdRow {...buttonProps} draft={draft} disabled={state.disabled} setDraft={setDraft} />
      {error ? <div data-usage-policy-error={targetKey(props.policy.target)} style={{ ...META, color: MC.fail, marginTop: 6 }}>{error.message}</div> : null}
    </div>
  );
}

interface WindowRowProps extends Omit<WindowPolicyBlockProps, 'policy'> {
  window: UsageWindowView;
}

function WindowRow(props: WindowRowProps) {
  const reset = props.window.resetElapsed
    ? props.copy.resetElapsed
    : props.window.resetIn === null ? null : `${props.copy.resetsIn} ${props.window.resetIn}`;
  return (
    <div data-usage-window={props.window.type} style={{ padding: '9px 0', borderTop: `1px solid ${MC.divider}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: MC.sub }}>{props.window.label}</span>
        <span style={{ marginLeft: 'auto', font: `600 10px ${MONO}`, color: MC.ink }}>{props.window.utilizationLabel ?? props.copy.unavailable}</span>
      </div>
      <div style={{ height: 5, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden', marginTop: 6 }}>
        <div style={{ width: props.window.utilizationWidth, height: '100%', background: MC.run }} />
      </div>
      {reset ? <div style={{ ...META, marginTop: 5 }}>{reset}</div> : null}
      {props.window.policy
        ? (
          <WindowPolicyBlock
            policy={props.window.policy}
            copy={props.copy}
            policyControlsState={props.policyControlsState}
            isPolicySaving={props.isPolicySaving}
            getPolicyError={props.getPolicyError}
            onSavePolicy={props.onSavePolicy}
          />
        )
        : null}
    </div>
  );
}

interface LegacyFallbackNoticeProps {
  fallback: ProviderLegacyFallbackView;
  copy: MUsageCopy;
  isPolicySaving: (target: UsagePolicyTarget) => boolean;
  getPolicyError: (target: UsagePolicyTarget) => { message: string } | null;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}

function LegacyFallbackNotice(props: LegacyFallbackNoticeProps) {
  const pending = props.isPolicySaving(props.fallback.target);
  const error = props.getPolicyError(props.fallback.target);
  const state = props.fallback.enabled ? props.copy.policy.enabled : props.copy.policy.disabled;
  return (
    <div data-usage-legacy-fallback={props.fallback.target.provider} style={{ marginTop: 10, border: `1px solid ${MC.divider}`, borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 650, color: MC.ink }}>{props.copy.policy.legacyFallbackTitle}</div>
      <div style={{ ...META, marginTop: 3 }}>{props.copy.policy.legacyFallbackBody}</div>
      <div style={{ ...META, marginTop: 3 }}>{`${state} · ${props.fallback.thresholdPercent}%`}</div>
      <button
        type="button"
        data-usage-legacy-clear={props.fallback.target.provider}
        disabled={pending}
        onClick={() => props.onSavePolicy(props.fallback.target, { enabled: true, thresholdPercent: null })}
        style={{
          marginTop: 8, borderRadius: 8, border: `1px solid ${MC.divider}`, padding: '7px 10px',
          background: MC.card, color: MC.sub, fontSize: 10.5, fontWeight: 650,
          opacity: pending ? 0.45 : 1, cursor: pending ? 'default' : 'pointer',
        }}
      >
        {pending ? props.copy.policy.saving : props.copy.policy.clearLegacy}
      </button>
      {error ? <div data-usage-policy-error={targetKey(props.fallback.target)} style={{ ...META, color: MC.fail, marginTop: 6 }}>{error.message}</div> : null}
    </div>
  );
}

interface QuotaBlockProps extends Omit<WindowPolicyBlockProps, 'policy'> {
  provider: ProviderUsageView;
}

function QuotaBlock(props: QuotaBlockProps) {
  const unavailable = props.provider.quotaState === 'unsupported' ? props.copy.quotaUnsupported : props.copy.neverObserved;
  const hasPolicies = props.provider.windows.some((window) => window.policy);
  return (
    <section data-usage-quota={props.provider.provider} data-usage-quota-state={props.provider.quotaState} style={{ padding: '10px 13px' }}>
      <div style={LABEL}>{props.copy.quota}</div>
      {props.provider.quotaState === 'available'
        ? props.provider.windows.map((window) => <WindowRow key={`${window.type}:${window.label}:${window.resetsAt ?? 'none'}`} window={window} {...props} />)
        : <div style={{ marginTop: 7, fontSize: 10.5, color: MC.muted }}>{unavailable}</div>}
      {hasPolicies ? <div data-usage-policy-future-hint={props.provider.provider} style={{ ...META, marginTop: 8 }}>{props.copy.policy.futureHint}</div> : null}
      {props.provider.legacyFallback
        ? (
          <LegacyFallbackNotice
            fallback={props.provider.legacyFallback}
            copy={props.copy}
            isPolicySaving={props.isPolicySaving}
            getPolicyError={props.getPolicyError}
            onSavePolicy={props.onSavePolicy}
          />
        )
        : null}
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

function ProviderCard(props: {
  provider: ProviderUsageView;
  copy: MUsageCopy;
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (target: UsagePolicyTarget) => boolean;
  getPolicyError: (target: UsagePolicyTarget) => { message: string } | null;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
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
      <QuotaBlock provider={provider} copy={copy} policyControlsState={props.policyControlsState} isPolicySaving={props.isPolicySaving} getPolicyError={props.getPolicyError} onSavePolicy={props.onSavePolicy} />
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
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (target: UsagePolicyTarget) => boolean;
  getPolicyError: (target: UsagePolicyTarget) => { message: string } | null;
  onBack: () => void;
  onRefresh: () => void;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}

export function MUsageView(props: MUsageViewProps) {
  const {
    view, copy, isLoading, queryError, refreshError, isRefreshing,
    policyControlsState, isPolicySaving, getPolicyError, onBack, onRefresh, onSavePolicy,
  } = props;
  const hasProviders = view.providers.length > 0;
  return (
    <>
      <MDrillHeader onBack={onBack} trailing={<RefreshButton copy={copy} pending={isRefreshing} onRefresh={onRefresh} />}>
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{copy.title}</div>
      </MDrillHeader>
      <MScrollBody gap={10}>
        {isLoading && !hasProviders ? <div style={{ color: MC.muted, fontSize: 12 }}>{copy.loading}</div> : null}
        <ErrorFeedback label={copy.loadError} error={queryError} />
        <ErrorFeedback label={copy.refreshError} error={refreshError} />
        {!isLoading && !queryError && !hasProviders ? <div style={{ color: MC.muted, fontSize: 12 }}>{copy.empty}</div> : null}
        {view.providers.map((provider) => (
          <ProviderCard
            key={provider.provider} provider={provider} copy={copy}
            policyControlsState={policyControlsState} isPolicySaving={isPolicySaving}
            getPolicyError={getPolicyError} onSavePolicy={onSavePolicy}
          />
        ))}
      </MScrollBody>
    </>
  );
}
