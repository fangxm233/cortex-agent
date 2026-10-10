import { useState, type CSSProperties } from 'react';
import type {
  ProviderLegacyFallbackView,
  UsageResetAttempt,
  UsageResetState,
  UsageResetsView,
  UsagePolicyControlsState,
  UsagePolicyDraft,
  UsagePolicyTarget,
  ProviderUsageView,
  UsageView,
  UsageWindowPolicyView,
  UsageWindowView,
} from '@/features/usage';
import { resetAttemptFor, resetOutcomeView, usagePolicyTargetKey } from '@/features/usage';
import { policyActionState, usePolicyThresholdDraft } from '@/features/usage/usage-policy-controls';
import { fmt, useVocab, type Vocab } from '@/i18n';
import { MButton, MC, MONO } from '@/mobile/ui/kit';
import { MSettingsSurfaceCard as MCard, MSettingsHeader as MDrillHeader,
  MSettingsFrame as MScreen, MSettingsBody as MScrollBody, MSettingsToggle } from './MSettingsControls';

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

function Observation({ provider, L }: { provider: ProviderUsageView; L: Vocab }) {
  if (provider.observedAt === null || provider.observedAgo === null) return null;
  const timestamp = isoTime(provider.observedAt);
  return (
    <span style={META}>
      {L.usageObserved}{' '}<time dateTime={timestamp} title={timestamp}>{L.usageAgo.replace('{d}', provider.observedAgo)}</time>
    </span>
  );
}

function PolicyToggle(props: {
  target: UsagePolicyTarget;
  label: string;
  enabled: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <MSettingsToggle label={props.label.replace('{key}', usagePolicyTargetKey(props.target))}
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
        data-usage-threshold-input={usagePolicyTargetKey(props.target)}
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
  L: Vocab;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}

function saveThreshold(props: PolicyThresholdButtonsProps): void {
  if (props.saveDisabled || props.parsedThreshold === null) return;
  props.onSavePolicy(props.policy.target, { enabled: props.policy.enabled, thresholdPercent: props.parsedThreshold });
}

function PolicySaveButton(props: PolicyThresholdButtonsProps) {
  return (
    <MButton
      compact variant="accent-outline" data-usage-threshold-save={usagePolicyTargetKey(props.policy.target)}
      disabled={props.saveDisabled} onClick={() => saveThreshold(props)}
    >
      {props.pending ? props.L.usagePolicySaving : props.L.usagePolicySave}
    </MButton>
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
    <MButton
      compact data-usage-threshold-reset={usagePolicyTargetKey(props.policy.target)}
      aria-label={props.L.usagePolicyResetDefault} title={props.L.usagePolicyResetDefault}
      disabled={props.resetDisabled}
      onClick={() => props.onSavePolicy(props.policy.target, { enabled: true, thresholdPercent: null })}
      style={{ width: 44, padding: 0 }}
    >
      <ResetIcon />
    </MButton>
  );
}

interface PolicyEditorProps {
  policy: UsageWindowPolicyView;
  L: Vocab;
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
    policy: props.policy, pending, parsedThreshold, L: props.L,
    saveDisabled: state.saveDisabled, resetDisabled: state.resetDisabled,
    onSavePolicy: props.onSavePolicy,
  };
  return (
    <div data-usage-policy-controls={usagePolicyTargetKey(props.policy.target)} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <PolicyToggle
        target={props.policy.target} label={props.L.usageThrottleToggle} enabled={props.policy.enabled} disabled={state.disabled}
        onClick={() => props.onSavePolicy(props.policy.target, {
          enabled: !props.policy.enabled, thresholdPercent: props.policy.thresholdPercent,
        })}
      />
      <span style={{ ...META, marginLeft: 'auto' }}>{props.L.usagePolicyThreshold}</span>
      <PolicyThresholdInput target={props.policy.target} label={props.L.usagePolicyThreshold} value={draft}
        disabled={state.disabled} onChange={setDraft} onSubmit={() => saveThreshold(buttons)} />
      <PolicySaveButton {...buttons} />
      <PolicyResetButton {...buttons} />
    </div>
  );
}

/** The collapsed throttle summary; it opens the editor below the reset line. */
function PolicySummary(props: { policy: UsageWindowPolicyView; L: Vocab; open: boolean; onToggle: () => void }) {
  const { policy, L } = props;
  return (
    <button
      type="button" data-usage-policy-expand={usagePolicyTargetKey(policy.target)} aria-expanded={props.open}
      aria-label={L.usagePolicyTitle} onClick={props.onToggle}
      style={{
        ...META, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
        border: 0, background: 'transparent', padding: '4px 0 4px 8px', cursor: 'pointer',
        color: props.open ? MC.ink : policy.enabled ? MC.sub : MC.muted,
      }}
    >
      {policy.enabled ? `${L.usageThrottleAt} ${policy.thresholdPercent}%` : L.usageThrottleOff}
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
      data-usage-policy-row={usagePolicyTargetKey(policy.target)} data-usage-policy-provider={policy.target.provider}
      data-usage-policy-window-type={policy.target.windowType ?? ''} data-usage-policy-window-label={policy.target.windowLabel ?? ''}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
        {props.reset ? <span style={META}>{props.reset}</span> : null}
        <PolicySummary policy={policy} L={props.L} open={open} onToggle={() => setExpanded(!open)} />
      </div>
      {open ? <PolicyEditor {...props} /> : null}
      {error ? <div data-usage-policy-error={usagePolicyTargetKey(policy.target)} style={{ ...META, color: MC.fail, marginTop: 6 }}>{error.message}</div> : null}
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
    ? props.L.usageResetElapsed
    : props.window.resetIn === null ? null : `${props.L.usageMobileResetsIn} ${props.window.resetIn}`;
  return (
    <div data-usage-window={props.window.type} style={{ padding: '9px 0', borderTop: `1px solid ${MC.divider}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: MC.sub }}>{props.window.label}</span>
        <span style={{ marginLeft: 'auto', font: `600 13px ${MONO}`, color: MC.ink }}>{props.window.utilizationLabel ?? props.L.usageUnavailable}</span>
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
  L: Vocab;
  isPolicySaving: (target: UsagePolicyTarget) => boolean;
  getPolicyError: (target: UsagePolicyTarget) => { message: string } | null;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}

function LegacyFallbackNotice(props: LegacyFallbackNoticeProps) {
  const pending = props.isPolicySaving(props.fallback.target);
  const error = props.getPolicyError(props.fallback.target);
  const state = props.fallback.enabled ? props.L.usagePolicyEnabled : props.L.usagePolicyDisabled;
  return (
    <div data-usage-legacy-fallback={props.fallback.target.provider} style={{ marginTop: 10, border: `1px solid ${MC.divider}`, borderRadius: 'var(--r-chip)', padding: '8px 10px' }}>
      <div style={{ fontSize: 13, fontWeight: 650, color: MC.ink }}>{props.L.usagePolicyLegacyTitle}</div>
      <div style={{ ...META, marginTop: 3 }}>{props.L.usagePolicyLegacyBody}</div>
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
        {pending ? props.L.usagePolicySaving : props.L.usagePolicyClearLegacy}
      </button>
      {error ? <div data-usage-policy-error={usagePolicyTargetKey(props.fallback.target)} style={{ ...META, color: MC.fail, marginTop: 6 }}>{error.message}</div> : null}
    </div>
  );
}

function resetSummary(resets: UsageResetsView, L: Vocab): string {
  const count = fmt(L.usageResets, { n: resets.available });
  return resets.nextExpiresIn === null ? count : `${count} · ${fmt(L.usageResetsNextExpiry, { d: resets.nextExpiresIn })}`;
}

function ResetOutcome({ attempt, L }: { attempt: UsageResetAttempt; L: Vocab }) {
  if (attempt.error) {
    return <div data-usage-reset-outcome="error" role="alert" style={{ ...META, color: MC.fail, marginTop: 6 }}>{L.usageResetFailed}: {attempt.error.message}</div>;
  }
  if (!attempt.status) return null;
  const outcome = resetOutcomeView(attempt.status);
  const color = outcome.tone === 'success' ? MC.done : MC.muted;
  return <div data-usage-reset-outcome={attempt.status} style={{ ...META, color, marginTop: 6 }}>{L[outcome.label]}</div>;
}

function ResetConfirm(props: { L: Vocab; lines: string[]; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div data-usage-reset-confirm style={{ marginTop: 8, border: `1px solid ${MC.amberBorder}`, background: MC.amberBg, borderRadius: 'var(--r-chip)', padding: '8px 10px' }}>
      {props.lines.map((line) => <div key={line} style={{ fontSize: 12, color: MC.amberText }}>{line}</div>)}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <MButton compact data-usage-reset-cancel onClick={props.onCancel}>{props.L.cancel}</MButton>
        <MButton compact variant="danger-outline" data-usage-reset-confirm-action onClick={props.onConfirm}>{props.L.usageResetConfirm}</MButton>
      </div>
    </div>
  );
}

/** Banked resets on a Codex or Claude row; spending one always takes a second, explicit confirm. */
function ResetRow({ resets, reset, L }: { resets: UsageResetsView; reset: UsageResetState; L: Vocab }) {
  const [confirming, setConfirming] = useState(false);
  const attempt = resetAttemptFor(reset, resets.provider);
  const provider = resets.provider;
  return (
    <div data-usage-resets={provider ?? ''} style={{ padding: '9px 0 0', borderTop: `1px solid ${MC.divider}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
        <span style={META}>{resetSummary(resets, L)}</span>
        {provider !== null && resets.available > 0 && !confirming
          ? (
            <MButton compact variant="accent-outline" data-usage-reset-use disabled={reset.isRedeeming}
              onClick={() => setConfirming(true)} style={{ marginLeft: 'auto', height: 32 }}>
              {attempt.isRedeeming ? L.usageResetUsing : L.usageResetUse}
            </MButton>
          )
          : null}
      </div>
      <ResetOutcome attempt={attempt} L={L} />
      {confirming && provider
        ? (
          <ResetConfirm L={L} lines={resets.confirm} onCancel={() => setConfirming(false)}
            onConfirm={() => { setConfirming(false); reset.redeem(provider); }} />
        )
        : null}
    </div>
  );
}

interface QuotaBlockProps extends Omit<PolicyEditorProps, 'policy'> {
  provider: ProviderUsageView;
  reset: UsageResetState;
}

function QuotaBlock(props: QuotaBlockProps) {
  if (props.provider.quotaState === 'unsupported') return null;
  return (
    <section data-usage-quota={props.provider.provider} data-usage-quota-state={props.provider.quotaState} style={{ padding: '10px 13px' }}>
      <div style={LABEL}>{props.L.usageMobileQuota}</div>
      {props.provider.quotaState === 'available'
        ? props.provider.windows.map((window) => <WindowRow key={`${window.type}:${window.label}:${window.resetsAt ?? 'none'}`} window={window} {...props} />)
        : <div style={{ marginTop: 8, fontSize: 12, color: MC.muted }}>{props.L.usageMobileNeverObserved}</div>}
      {props.provider.resets ? <ResetRow resets={props.provider.resets} reset={props.reset} L={props.L} /> : null}
      {props.provider.legacyFallback
        ? (
          <LegacyFallbackNotice
            fallback={props.provider.legacyFallback}
            L={props.L}
            isPolicySaving={props.isPolicySaving}
            getPolicyError={props.getPolicyError}
            onSavePolicy={props.onSavePolicy}
          />
        )
        : null}
    </section>
  );
}

function SpendBlock({ provider, L }: { provider: ProviderUsageView; L: Vocab }) {
  if (!provider.spend) return null;
  return (
    <section data-usage-spend={provider.provider} style={{ borderTop: `1px solid ${MC.divider}`, padding: '10px 13px' }}>
      <div style={LABEL}>{L.usageMobileGatewaySpend}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8 }}>
        <span style={{ font: `600 12px ${MONO}` }}>{provider.spend.today} <small>{L.usageMobileToday}</small></span>
        <span style={{ font: `600 12px ${MONO}` }}>{provider.spend.month} <small>{L.usageMobileMonth}</small></span>
        {provider.spend.all !== null && (
          <span style={{ font: `600 12px ${MONO}` }}>{provider.spend.all} <small>{L.usageMobileAllTime}</small></span>
        )}
      </div>
    </section>
  );
}

function ProviderCard(props: {
  provider: ProviderUsageView;
  L: Vocab;
  reset: UsageResetState;
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (target: UsagePolicyTarget) => boolean;
  getPolicyError: (target: UsagePolicyTarget) => { message: string } | null;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}) {
  const { provider, L } = props;
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
          <Observation provider={provider} L={L} />
        </div>
      </div>
      <QuotaBlock provider={provider} L={L} reset={props.reset} policyControlsState={props.policyControlsState} isPolicySaving={props.isPolicySaving} getPolicyError={props.getPolicyError} onSavePolicy={props.onSavePolicy} />
      <SpendBlock provider={provider} L={L} />
      {provider.note ? <div style={{ ...META, padding: '0 13px 10px' }}>{provider.note}</div> : null}
    </MCard>
  );
}

function ErrorFeedback({ label, error }: { label: string; error: { message: string } | null }) {
  if (!error) return null;
  return <div role="alert" style={{ color: MC.fail, fontSize: 12 }}>{label}: {error.message}</div>;
}

function RefreshButton({ L, pending, onRefresh }: { L: Vocab; pending: boolean; onRefresh: () => void }) {
  return (
    <button
      type="button"
      data-usage-refresh
      aria-busy={pending}
      onClick={onRefresh}
      style={{ border: 0, borderRadius: 'var(--r-chip)', padding: '7px 10px', background: MC.runBg, color: MC.run, fontSize: 10.5, fontWeight: 650 }}
    >
      {pending ? L.usageRefreshing : L.usageRefresh}
    </button>
  );
}

interface MUsageViewProps {
  view: UsageView;
  isLoading: boolean;
  queryError: { message: string } | null;
  refreshError: { message: string } | null;
  isRefreshing: boolean;
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (target: UsagePolicyTarget) => boolean;
  getPolicyError: (target: UsagePolicyTarget) => { message: string } | null;
  reset: UsageResetState;
  onBack: () => void;
  onRefresh: () => void;
  onSavePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}

export function MUsageView(props: MUsageViewProps) {
  const {
    view, isLoading, queryError, refreshError, isRefreshing,
    policyControlsState, isPolicySaving, getPolicyError, reset, onBack, onRefresh, onSavePolicy,
  } = props;
  const L = useVocab();
  const hasProviders = view.providers.length > 0;
  const header = (
    <MDrillHeader onBack={onBack} trailing={<RefreshButton L={L} pending={isRefreshing} onRefresh={onRefresh} />}>
      <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{L.stNavUsage}</div>
    </MDrillHeader>
  );
  return (
    <MScreen label="1l-u usage" header={header}>
      <MScrollBody>
        {isLoading && !hasProviders ? <div style={{ color: MC.muted, fontSize: 12 }}>{L.usageLoading}</div> : null}
        <ErrorFeedback label={L.usageLoadError} error={queryError} />
        <ErrorFeedback label={L.usageRefreshError} error={refreshError} />
        {!isLoading && !queryError && !hasProviders ? <div style={{ color: MC.muted, fontSize: 12 }}>{L.usageMobileEmpty}</div> : null}
        {view.providers.map((provider) => (
          <ProviderCard
            key={provider.key} provider={provider} L={L} reset={reset}
            policyControlsState={policyControlsState} isPolicySaving={isPolicySaving}
            getPolicyError={getPolicyError} onSavePolicy={onSavePolicy}
          />
        ))}
      </MScrollBody>
    </MScreen>
  );
}
