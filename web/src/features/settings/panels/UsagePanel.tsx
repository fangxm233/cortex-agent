import { useState, type CSSProperties, type ReactNode } from 'react';
import { fmt, useVocab } from '@/i18n';
import {
  ROW_STYLE,
  SButton,
  SDot,
  SHeaderActions,
  SMeter,
  SNotice,
  SRowGroup,
  SSection,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
  Toggle,
} from '@/features/settings/ui/settings-ui';
import { policyActionState, usePolicyThresholdDraft } from '@/features/usage/usage-policy-controls';
import {
  resetAttemptFor, useUsage, type UsageResetAttempt, type UsageResetState,
} from '@/features/usage/useUsage';
import { useUsageSharingController } from '@/features/settings/controllers/useUsageSharingController';
import { UsageSharingCard } from './UsageSharingCard';
import {
  resetOutcomeView,
  type ProviderLegacyFallbackView,
  type ProviderUsageView,
  type UsageResetsView,
  type UsagePolicyTarget,
  usagePolicyTargetKey,
  type UsageSeverity,
  type UsageWindowPolicyView,
  type UsageWindowView,
} from '@/features/usage/usage-vm';

const SEVERITY_FILL: Record<UsageSeverity, string> = {
  normal: 'var(--proto-accent)',
  warning: 'var(--proto-amber)',
  danger: 'var(--proto-danger)',
};

// Modes, ages and reset times are labels and numbers: UI face, tabular figures.
const META_TEXT: CSSProperties = {
  fontSize: 12, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums', color: 'var(--proto-muted-2)', overflowWrap: 'anywhere',
};
// A quota window is one line: name · meter · percent · reset · throttle, in fixed slots so the
// meters of a provider line up.
const WINDOW_LINE: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 12, rowGap: 4 };
const WINDOW_NAME: CSSProperties = {
  width: 104, flex: 'none', fontSize: 13, fontWeight: 500, color: 'var(--proto-ink)', overflowWrap: 'anywhere',
};
const WINDOW_METER: CSSProperties = { flex: '1 1 120px', minWidth: 80 };
const WINDOW_PERCENT: CSSProperties = {
  minWidth: 40, flex: 'none', textAlign: 'right', fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
  color: 'var(--proto-ink)',
};
const WINDOW_RESET: CSSProperties = { width: 132, flex: 'none' };
const POLICY_TEXT: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: 'var(--proto-muted)', overflowWrap: 'anywhere' };
// The kit control scale, widened on the right only: the `%` suffix is painted over the field.
const POLICY_INPUT: CSSProperties = { ...S_CONTROL_STYLE, width: 84, paddingRight: 24 };
const POLICY_INPUT_DISABLED: CSSProperties = { ...S_CONTROL_DISABLED_STYLE, width: 84, paddingRight: 24 };

function isoTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function Observation({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  if (provider.observedAt === null || provider.observedAgo === null) return null;
  const timestamp = isoTime(provider.observedAt);
  return (
    <span>
      {L.usageObserved}{' '}
      <time dateTime={timestamp} title={timestamp}>{L.usageAgo.replace('{d}', provider.observedAgo)}</time>
    </span>
  );
}

function ProviderMeta({ provider }: { provider: ProviderUsageView }) {
  return (
    <span style={{ ...META_TEXT, display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span>{provider.modes.join(' · ')}</span>
      <Observation provider={provider} />
    </span>
  );
}

function ResetLine({ window }: { window: UsageWindowView }) {
  const L = useVocab();
  if (window.resetElapsed) return <div style={META_TEXT}>{L.usageResetElapsed}</div>;
  if (window.resetsAt === null || window.resetIn === null) return null;
  const timestamp = isoTime(window.resetsAt);
  return (
    <div style={META_TEXT}>
      {L.usageResetsIn}{' '}<time dateTime={timestamp} title={timestamp}>{window.resetIn}</time>
    </div>
  );
}

function ThresholdField(props: {
  disabled: boolean;
  target: UsagePolicyTarget;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const L = useVocab();
  return (
    <div style={{ position: 'relative', width: 84, flex: 'none' }}>
      <input
        data-usage-threshold-input={usagePolicyTargetKey(props.target)}
        aria-label={L.usagePolicyThreshold}
        type="number"
        min={1}
        max={100}
        step="0.1"
        inputMode="decimal"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') props.onSubmit(); }}
        style={props.disabled ? POLICY_INPUT_DISABLED : POLICY_INPUT}
      />
      <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, fontWeight: 500, color: 'var(--proto-muted-2)' }}>%</span>
    </div>
  );
}

type SavePolicyHandler = ReturnType<typeof useUsage>['savePolicy'];

type PendingPolicyGetter = ReturnType<typeof useUsage>['isPolicySaving'];
type PolicyErrorGetter = ReturnType<typeof useUsage>['getPolicyError'];

interface PolicyThresholdButtonsProps {
  policy: UsageWindowPolicyView;
  pending: boolean;
  saveDisabled: boolean;
  resetDisabled: boolean;
  parsedThreshold: number | null;
  onSavePolicy: SavePolicyHandler;
}

interface PolicyEditorProps {
  policy: UsageWindowPolicyView;
  controlsState: ReturnType<typeof useUsage>['policyControlsState'];
  isPolicySaving: PendingPolicyGetter;
  onSavePolicy: SavePolicyHandler;
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

function saveThreshold(props: PolicyThresholdButtonsProps): void {
  if (props.saveDisabled || props.parsedThreshold === null) return;
  props.onSavePolicy(props.policy.target, {
    enabled: props.policy.enabled, thresholdPercent: props.parsedThreshold,
  });
}

function resetThreshold(props: PolicyThresholdButtonsProps): void {
  props.onSavePolicy(props.policy.target, { enabled: true, thresholdPercent: null });
}

function PolicyThresholdButtons(props: PolicyThresholdButtonsProps) {
  const L = useVocab();
  const key = usagePolicyTargetKey(props.policy.target);
  return (
    <>
      <SButton tone="neutral" data-usage-threshold-save={key}
        disabled={props.saveDisabled} onClick={() => saveThreshold(props)}>
        {props.pending ? L.usagePolicySaving : L.usagePolicySave}
      </SButton>
      <SButton tone="neutral" data-usage-threshold-reset={key}
        style={{ width: 40, paddingLeft: 0, paddingRight: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        aria-label={L.usagePolicyResetDefault} title={L.usagePolicyResetDefault}
        disabled={props.resetDisabled} onClick={() => resetThreshold(props)}>
        <ResetIcon />
      </SButton>
    </>
  );
}

function PolicyError({ target, message }: { target: UsagePolicyTarget; message: string }) {
  return (
    <div data-usage-policy-error={usagePolicyTargetKey(target)} style={{ ...POLICY_TEXT, color: 'var(--proto-danger)', marginTop: 8 }}>
      {message}
    </div>
  );
}

/** The collapsed throttle summary; it opens the editor below the reset line. */
function PolicySummary(props: { policy: UsageWindowPolicyView; open: boolean; onToggle: () => void }) {
  const L = useVocab();
  const { policy } = props;
  return (
    <button
      type="button" data-usage-policy-expand={usagePolicyTargetKey(policy.target)} aria-expanded={props.open}
      title={L.usagePolicyTitle} onClick={props.onToggle}
      style={{
        ...META_TEXT, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
        border: 0, background: 'transparent', padding: '2px 0', cursor: 'pointer',
        color: props.open ? 'var(--proto-ink)' : policy.enabled ? 'var(--proto-muted)' : 'var(--proto-muted-2)',
      }}
    >
      {policy.enabled ? `${L.usageThrottleAt} ${policy.thresholdPercent}%` : L.usageThrottleOff}
      <ChevronIcon open={props.open} />
    </button>
  );
}

function PolicyEditor(props: PolicyEditorProps) {
  const L = useVocab();
  const key = usagePolicyTargetKey(props.policy.target);
  const toggleLabel = fmt(L.usageThrottleToggle, { key });
  const pending = props.isPolicySaving(props.policy.target);
  const { draft, parsedThreshold, setDraft } = usePolicyThresholdDraft(props.policy);
  const state = policyActionState(props.controlsState !== 'ready', pending, parsedThreshold, props.policy);
  const buttons: PolicyThresholdButtonsProps = {
    policy: props.policy, pending, parsedThreshold,
    saveDisabled: state.saveDisabled, resetDisabled: state.resetDisabled, onSavePolicy: props.onSavePolicy,
  };
  const onToggle = state.disabled
    ? undefined
    : () => props.onSavePolicy(props.policy.target, {
        enabled: !props.policy.enabled,
        thresholdPercent: props.policy.thresholdPercent,
      });
  return (
    <div data-usage-policy-controls={key} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
      <Toggle on={props.policy.enabled} onClick={onToggle} ariaLabel={toggleLabel} inert={state.disabled} />
      <span style={{ ...META_TEXT, marginLeft: 4 }}>{L.usagePolicyThreshold}</span>
      <ThresholdField disabled={state.disabled} target={props.policy.target} value={draft} onChange={setDraft}
        onSubmit={() => saveThreshold(buttons)} />
      <PolicyThresholdButtons {...buttons} />
    </div>
  );
}

function policyRowAttrs(policy: UsageWindowPolicyView | null): Record<string, string> {
  if (!policy) return {};
  return {
    'data-usage-policy-row': usagePolicyTargetKey(policy.target),
    'data-usage-policy-provider': policy.target.provider,
    'data-usage-policy-window-type': policy.target.windowType ?? '',
    'data-usage-policy-window-label': policy.target.windowLabel ?? '',
  };
}

function WindowLine(props: { window: UsageWindowView; open: boolean; onToggle: () => void }) {
  const L = useVocab();
  const view = props.window;
  return (
    <div style={WINDOW_LINE}>
      <span style={WINDOW_NAME}>{view.label}</span>
      <span style={WINDOW_METER}>
        {view.utilization === null ? null : (
          <SMeter percent={view.utilization * 100} tone={SEVERITY_FILL[view.severity]}
            marker={view.policy?.enabled ? view.policy.thresholdPercent : undefined} />
        )}
      </span>
      <span style={WINDOW_PERCENT}>{view.utilizationLabel ?? L.usageUnavailable}</span>
      <div style={WINDOW_RESET}><ResetLine window={view} /></div>
      {view.policy ? <PolicySummary policy={view.policy} open={props.open} onToggle={props.onToggle} /> : null}
    </div>
  );
}

function WindowRow(props: { window: UsageWindowView; usage: ReturnType<typeof useUsage> }) {
  const [expanded, setExpanded] = useState(false);
  const view = props.window;
  const { policy } = view;
  const error = policy ? props.usage.getPolicyError(policy.target) : null;
  const open = expanded || error !== null;
  return (
    <div className="settings-usage-window" data-usage-window={view.type} data-usage-severity={view.severity}
      {...policyRowAttrs(policy)} style={{ padding: ROW_STYLE.padding }}>
      <WindowLine window={view} open={open} onToggle={() => setExpanded(!open)} />
      {policy && open ? (
        <PolicyEditor policy={policy} controlsState={props.usage.policyControlsState}
          isPolicySaving={props.usage.isPolicySaving} onSavePolicy={props.usage.savePolicy} />
      ) : null}
      {policy && error ? <PolicyError target={policy.target} message={error.message} /> : null}
    </div>
  );
}

function LegacyFallbackNotice(props: {
  fallback: ProviderLegacyFallbackView;
  isPolicySaving: PendingPolicyGetter;
  getPolicyError: PolicyErrorGetter;
  onSavePolicy: SavePolicyHandler;
}) {
  const L = useVocab();
  const pending = props.isPolicySaving(props.fallback.target);
  const error = props.getPolicyError(props.fallback.target);
  return (
    <SNotice
      tone="amber" data-usage-legacy-fallback={props.fallback.target.provider}
      action={(
        <SButton
          tone="neutral" data-usage-legacy-clear={props.fallback.target.provider} disabled={pending}
          onClick={() => props.onSavePolicy(props.fallback.target, { enabled: true, thresholdPercent: null })}
        >
          {pending ? L.usagePolicySaving : L.usagePolicyClearLegacy}
        </SButton>
      )}
    >
      <div style={{ fontWeight: 600 }}>{L.usagePolicyLegacyTitle}</div>
      <div style={{ marginTop: 3 }}>{L.usagePolicyLegacyBody}</div>
      <div style={{ marginTop: 3 }}>{`${props.fallback.enabled ? L.usagePolicyEnabled : L.usagePolicyDisabled} · ${props.fallback.thresholdPercent}%`}</div>
      {error ? <PolicyError target={props.fallback.target} message={error.message} /> : null}
    </SNotice>
  );
}

function ResetSummary({ resets }: { resets: UsageResetsView }) {
  const L = useVocab();
  const expiry = resets.nextExpiresAt !== null && resets.nextExpiresIn !== null
    ? <span title={isoTime(resets.nextExpiresAt)}>{` · ${fmt(L.usageResetsNextExpiry, { d: resets.nextExpiresIn })}`}</span>
    : null;
  return <span style={META_TEXT}>{fmt(L.usageResets, { n: resets.available })}{expiry}</span>;
}

function ResetOutcome({ attempt }: { attempt: UsageResetAttempt }) {
  const L = useVocab();
  if (attempt.error) {
    return (
      <span data-usage-reset-outcome="error" style={{ ...META_TEXT, color: 'var(--proto-danger)' }}>
        {L.usageResetFailed}: {attempt.error.message}
      </span>
    );
  }
  if (!attempt.status) return null;
  const outcome = resetOutcomeView(attempt.status);
  const color = outcome.tone === 'success' ? 'var(--proto-accent)' : 'var(--proto-muted)';
  return <span data-usage-reset-outcome={attempt.status} style={{ ...META_TEXT, color }}>{L[outcome.label]}</span>;
}

function ResetConfirm(props: { lines: string[]; onConfirm: () => void; onCancel: () => void }) {
  const L = useVocab();
  return (
    <SNotice
      tone="amber" data-usage-reset-confirm
      action={(
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <SButton tone="neutral" data-usage-reset-cancel onClick={props.onCancel}>{L.cancel}</SButton>
          <SButton tone="danger" data-usage-reset-confirm-action onClick={props.onConfirm}>{L.usageResetConfirm}</SButton>
        </span>
      )}
    >
      {props.lines.map((line) => <div key={line}>{line}</div>)}
    </SNotice>
  );
}

/** Banked resets on a Codex or Claude row; spending one always takes a second, explicit confirm. */
function ResetCredits({ resets, reset }: { resets: UsageResetsView; reset: UsageResetState }) {
  const L = useVocab();
  const [confirming, setConfirming] = useState(false);
  const attempt = resetAttemptFor(reset, resets.provider);
  const provider = resets.provider;
  const canUse = provider !== null && resets.available > 0 && !confirming;
  return (
    <div data-usage-resets={provider ?? ''} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: ROW_STYLE.padding }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minHeight: 28 }}>
        <ResetSummary resets={resets} />
        <ResetOutcome attempt={attempt} />
        {canUse
          ? (
            <SButton tone="neutral" data-usage-reset-use disabled={reset.isRedeeming}
              onClick={() => setConfirming(true)} style={{ marginLeft: 'auto' }}>
              {attempt.isRedeeming ? L.usageResetUsing : L.usageResetUse}
            </SButton>
          )
          : null}
      </div>
      {confirming && provider
        ? (
          <ResetConfirm lines={resets.confirm} onCancel={() => setConfirming(false)}
            onConfirm={() => { setConfirming(false); reset.redeem(provider); }} />
        )
        : null}
    </div>
  );
}

function SpendFigure({ value, caption }: { value: string; caption: string }) {
  return (
    <span data-usage-spend-figure={caption} data-usage-spend-value={value}
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, fontVariantNumeric: 'tabular-nums' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{value}</span>
      <span style={META_TEXT}>{caption}</span>
    </span>
  );
}

function SpendRow({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  if (!provider.spend) return null;
  return (
    <div data-usage-spend={provider.provider} style={{ ...WINDOW_LINE, padding: ROW_STYLE.padding }}>
      <span style={WINDOW_NAME}>{L.usageGatewaySpend}</span>
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 18, rowGap: 4 }}>
        <SpendFigure value={provider.spend.today} caption={L.usageToday} />
        <SpendFigure value={provider.spend.month} caption={L.usageMonth} />
        {provider.spend.all !== null && <SpendFigure value={provider.spend.all} caption={L.usageAllTime} />}
      </span>
    </div>
  );
}

function quotaRows(provider: ProviderUsageView, usage: ReturnType<typeof useUsage>, L: ReturnType<typeof useVocab>): ReactNode[] {
  if (provider.quotaState === 'unsupported') return [];
  const rows: ReactNode[] = provider.quotaState === 'available'
    ? provider.windows.map((window) => (
      <WindowRow key={`${window.type}:${window.label}:${window.resetsAt ?? 'none'}`} window={window} usage={usage} />
    ))
    : [<div key="never" style={{ ...ROW_STYLE, ...META_TEXT }}>{L.usageNeverObserved}</div>];
  if (provider.resets) rows.push(<ResetCredits key="resets" resets={provider.resets} reset={usage.reset} />);
  return rows;
}

/** Quota windows, banked resets and gateway spend share one run of rows under the provider. */
function ProviderRows({ provider, usage }: { provider: ProviderUsageView; usage: ReturnType<typeof useUsage> }) {
  const L = useVocab();
  const rows = quotaRows(provider, usage, L);
  if (provider.spend) rows.push(<SpendRow key="spend" provider={provider} />);
  if (rows.length === 0) return null;
  const quota = provider.quotaState === 'unsupported'
    ? {} : { 'data-usage-quota': provider.provider, 'data-usage-quota-state': provider.quotaState };
  return <section className="settings-flush" {...quota}><SRowGroup>{rows}</SRowGroup></section>;
}

function ProviderNotices({ provider, usage }: { provider: ProviderUsageView; usage: ReturnType<typeof useUsage> }) {
  const legacy = provider.quotaState === 'unsupported' ? null : provider.legacyFallback;
  const error = provider.note && provider.noteTone === 'error' ? provider.note : null;
  if (!legacy && !error) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
      {legacy ? (
        <LegacyFallbackNotice fallback={legacy} isPolicySaving={usage.isPolicySaving}
          getPolicyError={usage.getPolicyError} onSavePolicy={usage.savePolicy} />
      ) : null}
      {error ? (
        <SNotice tone="danger" data-usage-note="error" icon={<SDot color="var(--proto-danger)" size={6} />}>{error}</SNotice>
      ) : null}
    </div>
  );
}

function ProviderSection({ provider, usage }: { provider: ProviderUsageView; usage: ReturnType<typeof useUsage> }) {
  return (
    <SSection data-usage-provider={provider.provider} data-usage-billing={provider.billing ?? ''}
      label={provider.displayName} action={<ProviderMeta provider={provider} />}>
      <ProviderRows provider={provider} usage={usage} />
      <ProviderNotices provider={provider} usage={usage} />
    </SSection>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flex: 'none', display: 'block' }}
    >
      <g>
        {spinning ? <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" /> : null}
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
        <path d="M8 16H3v5" />
      </g>
    </svg>
  );
}

function RefreshToolbar({ usage }: { usage: ReturnType<typeof useUsage> }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
      {usage.refreshError
        ? (
          <span title={usage.refreshError.message} style={{
            ...POLICY_TEXT, color: 'var(--proto-danger)', maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
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

function UsageContent({ usage }: { usage: ReturnType<typeof useUsage> }): ReactNode {
  const L = useVocab();
  if (usage.isLoading) return <SNotice tone="muted">{L.usageLoading}</SNotice>;
  if (usage.queryError) {
    return (
      <SNotice tone="danger" icon={<SDot color="var(--proto-danger)" size={6} />}>
        {L.usageLoadError}: {usage.queryError.message}
      </SNotice>
    );
  }
  if (usage.view.providers.length === 0) return <SNotice tone="muted">{L.usageEmpty}</SNotice>;
  // One section per provider, each a run of quota rows.
  return (
    <div data-usage-cards style={{ display: 'flex', flexDirection: 'column', gap: 'var(--settings-section-gap, 20px)' }}>
      {usage.view.providers.map((provider) => <ProviderSection key={provider.key} provider={provider} usage={usage} />)}
    </div>
  );
}

export function UsagePanel() {
  const usage = useUsage();
  const sharing = useUsageSharingController();
  return (
    <>
      <SHeaderActions><div data-usage-header><RefreshToolbar usage={usage} /></div></SHeaderActions>
      <UsageContent usage={usage} />
      <UsageSharingCard controller={sharing} variant="settings" />
    </>
  );
}
