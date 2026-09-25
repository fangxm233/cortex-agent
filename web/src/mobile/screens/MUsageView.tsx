// input:  usage VM, policy controls, mobile Settings primitives
// output: MUsageView
// pos:    Mobile usage material cards; throttle policy summarized inline, edited on demand
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useState, type CSSProperties } from 'react';
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
import { MC, MONO } from '@/mobile/ui/kit';
import { MSettingsSurfaceCard as MCard, MSettingsHeader as MDrillHeader,
  MSettingsFrame as MScreen, MSettingsBody as MScrollBody, MSettingsToggle } from './MSettingsControls';

export interface MUsageCopy {
  title: string;
  refresh: string;
  refreshing: string;
  loading: string;
  loadError: string;
  refreshError: string;
  empty: string;
  quota: string;
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
    disabled: string;
    threshold: string;
    save: string;
    saving: string;
    resetDefault: string;
    throttleAt: string;
    throttleOff: string;
    legacyFallbackTitle: string;
    legacyFallbackBody: string;
    clearLegacy: string;
  };
}

const META: CSSProperties = { fontSize: 12, color: MC.muted };
const LABEL: CSSProperties = { fontSize: 13, fontWeight: 600, color: MC.muted };
const POLICY_INPUT: CSSProperties = {
  width: '100%',
  borderRadius: 'var(--r-chip)',
  border: `1px solid ${MC.divider}`,
  background: 'var(--material-inset-bg)',
  color: MC.ink,
  fontSize: 16,
  padding: '7px 22px 7px 8px',
  boxSizing: 'border-box',
};

function isoTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function targetKey(target: UsagePolicyTarget): string {
  return usagePolicyTargetKey(target);
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
    <MSettingsToggle label={`Usage throttle ${targetKey(props.target)}`}
      value={props.enabled} disabled={props.disabled} onChange={props.onClick} />
  );
}

function PolicyThresholdInput(props: {
  target: UsagePolicyTarget;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div style={{ position: 'relative', width: 84 }}>
      <input
        data-usage-threshold-input={targetKey(props.target)}
        aria-label={props.label}
        type="number"
        min={1}
        max={100}
        step="0.1"
        inputMode="decimal"
        enterKeyHint="done"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') props.onSubmit(); }}
        style={{ ...POLICY_INPUT, opacity: props.disabled ? 0.55 : 1 }}
      />
      <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', font: `500 12px ${MONO}`, color: MC.muted }}>%</span>
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

function saveThreshold(props: PolicyThresholdButtonsProps): void {
  if (props.saveDisabled || props.parsedThreshold === null) return;
  props.onSavePolicy(props.policy.target, { enabled: props.policy.enabled, thresholdPercent: props.parsedThreshold });
}

function PolicySaveButton(props: PolicyThresholdButtonsProps) {
  return (
    <button
      type="button" data-usage-threshold-save={targetKey(props.policy.target)} disabled={props.saveDisabled}
      onClick={() => saveThreshold(props)}
      style={{
        border: 0, borderRadius: 'var(--r-chip)', padding: '7px 10px', background: MC.runBg,
        color: MC.run, fontSize: 10.5, fontWeight: 650,
        opacity: props.saveDisabled ? 0.45 : 1, cursor: props.saveDisabled ? 'default' : 'pointer',
      }}
    >
      {props.pending ? props.copy.policy.saving : props.copy.policy.save}
    </button>
  );
}

function ResetIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flex: 'none', transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function PolicyResetButton(props: PolicyThresholdButtonsProps) {
  return (
    <button
      type="button" data-usage-threshold-reset={targetKey(props.policy.target)}
      aria-label={props.copy.policy.resetDefault} title={props.copy.policy.resetDefault}
      disabled={props.resetDisabled}
      onClick={() => props.onSavePolicy(props.policy.target, { enabled: true, thresholdPercent: null })}
      style={{
        width: 30, height: 30, borderRadius: 'var(--r-chip)', border: `1px solid ${MC.divider}`, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: MC.sub,
        opacity: props.resetDisabled ? 0.45 : 1, cursor: props.resetDisabled ? 'default' : 'pointer',
      }}
    >
      <ResetIcon />
    </button>
  );
}

interface PolicyEditorProps {
  policy: UsageWindowPolicyView;
  copy: MUsageCopy;
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (target: UsagePolicyTarget) => boolean;
  getPolicyError: (target: UsagePolicyTarget) => { message: string } | null;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}

function PolicyEditor(props: PolicyEditorProps) {
  const pending = props.isPolicySaving(props.policy.target);
  const { draft, parsedThreshold, setDraft } = usePolicyThresholdDraft(props.policy);
  const state = policyActionState(props.policyControlsState !== 'ready', pending, parsedThreshold, props.policy);
  const buttons: PolicyThresholdButtonsProps = {
    policy: props.policy, pending, parsedThreshold, copy: props.copy,
    saveDisabled: state.saveDisabled, resetDisabled: state.resetDisabled,
    onSavePolicy: props.onSavePolicy,
  };
  return (
    <div data-usage-policy-controls={targetKey(props.policy.target)} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <PolicyToggle
        target={props.policy.target} enabled={props.policy.enabled} disabled={state.disabled}
        onClick={() => props.onSavePolicy(props.policy.target, {
          enabled: !props.policy.enabled, thresholdPercent: props.policy.thresholdPercent,
        })}
      />
      <span style={{ ...META, marginLeft: 'auto' }}>{props.copy.policy.threshold}</span>
      <PolicyThresholdInput target={props.policy.target} label={props.copy.policy.threshold} value={draft}
        disabled={state.disabled} onChange={setDraft} onSubmit={() => saveThreshold(buttons)} />
      <PolicySaveButton {...buttons} />
      <PolicyResetButton {...buttons} />
    </div>
  );
}

/** The collapsed throttle summary; it opens the editor below the reset line. */
function PolicySummary(props: { policy: UsageWindowPolicyView; copy: MUsageCopy; open: boolean; onToggle: () => void }) {
  const { policy, copy } = props;
  return (
    <button
      type="button" data-usage-policy-expand={targetKey(policy.target)} aria-expanded={props.open}
      aria-label={copy.policy.title} onClick={props.onToggle}
      style={{
        ...META, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
        border: 0, background: 'transparent', padding: '4px 0 4px 8px', cursor: 'pointer',
        color: props.open ? MC.ink : policy.enabled ? MC.sub : MC.muted,
      }}
    >
      {policy.enabled ? `${copy.policy.throttleAt} ${policy.thresholdPercent}%` : copy.policy.throttleOff}
      <ChevronIcon open={props.open} />
    </button>
  );
}

function WindowPolicy(props: PolicyEditorProps & { reset: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const { policy } = props;
  const error = props.getPolicyError(policy.target);
  const open = expanded || error !== null;
  return (
    <div
      data-usage-policy-row={targetKey(policy.target)} data-usage-policy-provider={policy.target.provider}
      data-usage-policy-window-type={policy.target.windowType ?? ''} data-usage-policy-window-label={policy.target.windowLabel ?? ''}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
        {props.reset ? <span style={META}>{props.reset}</span> : null}
        <PolicySummary policy={policy} copy={props.copy} open={open} onToggle={() => setExpanded(!open)} />
      </div>
      {open ? <PolicyEditor {...props} /> : null}
      {error ? <div data-usage-policy-error={targetKey(policy.target)} style={{ ...META, color: MC.fail, marginTop: 6 }}>{error.message}</div> : null}
    </div>
  );
}

interface WindowRowProps extends Omit<PolicyEditorProps, 'policy'> {
  window: UsageWindowView;
}

function WindowMeter({ window }: { window: UsageWindowView }) {
  const marker = window.policy?.enabled ? Math.max(0, Math.min(100, window.policy.thresholdPercent)) : null;
  return (
    <div style={{ position: 'relative', marginTop: 6 }}>
      <div style={{ height: 5, borderRadius: 'var(--r-pill)', background: 'var(--proto-line-2)', overflow: 'hidden' }}>
        <div className="usage-meter-fill" style={{ width: window.utilizationWidth, height: '100%', background: MC.run }} />
      </div>
      {marker === null
        ? null
        : <span data-meter-marker aria-hidden="true" style={{ position: 'absolute', top: -2, bottom: -2, width: 2, borderRadius: 1, left: `calc(${marker}% - 1px)`, background: MC.muted, opacity: 0.7 }} />}
    </div>
  );
}

function WindowRow(props: WindowRowProps) {
  const reset = props.window.resetElapsed
    ? props.copy.resetElapsed
    : props.window.resetIn === null ? null : `${props.copy.resetsIn} ${props.window.resetIn}`;
  return (
    <div data-usage-window={props.window.type} style={{ padding: '9px 0', borderTop: `1px solid ${MC.divider}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: MC.sub }}>{props.window.label}</span>
        <span style={{ marginLeft: 'auto', font: `600 13px ${MONO}`, color: MC.ink }}>{props.window.utilizationLabel ?? props.copy.unavailable}</span>
      </div>
      <WindowMeter window={props.window} />
      {props.window.policy
        ? <WindowPolicy {...props} policy={props.window.policy} reset={reset} />
        : reset ? <div style={{ ...META, marginTop: 5 }}>{reset}</div> : null}
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
    <div data-usage-legacy-fallback={props.fallback.target.provider} style={{ marginTop: 10, border: `1px solid ${MC.divider}`, borderRadius: 'var(--r-chip)', padding: '8px 10px' }}>
      <div style={{ fontSize: 13, fontWeight: 650, color: MC.ink }}>{props.copy.policy.legacyFallbackTitle}</div>
      <div style={{ ...META, marginTop: 3 }}>{props.copy.policy.legacyFallbackBody}</div>
      <div style={{ ...META, marginTop: 3 }}>{`${state} · ${props.fallback.thresholdPercent}%`}</div>
      <button
        type="button"
        data-usage-legacy-clear={props.fallback.target.provider}
        disabled={pending}
        onClick={() => props.onSavePolicy(props.fallback.target, { enabled: true, thresholdPercent: null })}
        style={{
          marginTop: 8, borderRadius: 'var(--r-chip)', border: `1px solid ${MC.divider}`, padding: '7px 10px',
          background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: MC.sub, fontSize: 10.5, fontWeight: 650,
          opacity: pending ? 0.45 : 1, cursor: pending ? 'default' : 'pointer',
        }}
      >
        {pending ? props.copy.policy.saving : props.copy.policy.clearLegacy}
      </button>
      {error ? <div data-usage-policy-error={targetKey(props.fallback.target)} style={{ ...META, color: MC.fail, marginTop: 6 }}>{error.message}</div> : null}
    </div>
  );
}

interface QuotaBlockProps extends Omit<PolicyEditorProps, 'policy'> {
  provider: ProviderUsageView;
}

function QuotaBlock(props: QuotaBlockProps) {
  if (props.provider.quotaState === 'unsupported') return null;
  return (
    <section data-usage-quota={props.provider.provider} data-usage-quota-state={props.provider.quotaState} style={{ padding: '10px 13px' }}>
      <div style={LABEL}>{props.copy.quota}</div>
      {props.provider.quotaState === 'available'
        ? props.provider.windows.map((window) => <WindowRow key={`${window.type}:${window.label}:${window.resetsAt ?? 'none'}`} window={window} {...props} />)
        : <div style={{ marginTop: 8, fontSize: 12, color: MC.muted }}>{props.copy.neverObserved}</div>}
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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8 }}>
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
      <div
        data-usage-provider={provider.provider} data-usage-billing={provider.billing ?? ''}
        style={{ padding: '11px 13px 8px' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 650, color: MC.ink }}>{provider.displayName}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
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
  return <div role="alert" style={{ color: MC.fail, fontSize: 12 }}>{label}: {error.message}</div>;
}

function RefreshButton({ copy, pending, onRefresh }: { copy: MUsageCopy; pending: boolean; onRefresh: () => void }) {
  return (
    <button
      type="button"
      data-usage-refresh
      aria-busy={pending}
      onClick={onRefresh}
      style={{ border: 0, borderRadius: 'var(--r-chip)', padding: '7px 10px', background: MC.runBg, color: MC.run, fontSize: 10.5, fontWeight: 650 }}
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
  const header = (
    <MDrillHeader onBack={onBack} trailing={<RefreshButton copy={copy} pending={isRefreshing} onRefresh={onRefresh} />}>
      <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{copy.title}</div>
    </MDrillHeader>
  );
  return (
    <MScreen label="1l-u 用量" header={header}>
      <MScrollBody gap={10}>
        {isLoading && !hasProviders ? <div style={{ color: MC.muted, fontSize: 12 }}>{copy.loading}</div> : null}
        <ErrorFeedback label={copy.loadError} error={queryError} />
        <ErrorFeedback label={copy.refreshError} error={refreshError} />
        {!isLoading && !queryError && !hasProviders ? <div style={{ color: MC.muted, fontSize: 12 }}>{copy.empty}</div> : null}
        {view.providers.map((provider) => (
          <ProviderCard
            key={provider.key} provider={provider} copy={copy}
            policyControlsState={policyControlsState} isPolicySaving={isPolicySaving}
            getPolicyError={getPolicyError} onSavePolicy={onSavePolicy}
          />
        ))}
      </MScrollBody>
    </MScreen>
  );
}
