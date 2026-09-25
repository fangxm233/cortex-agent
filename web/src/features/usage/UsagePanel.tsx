// input:  usage resource, policy draft, settings atoms
// output: desktop provider quota tiles, header refresh and collapsible throttle controls
// pos:    Readable provider quotas; throttle policy summarized inline, edited on demand
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import '@/features/settings/ui/desktop-panels.css';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useVocab } from '@/i18n';
import {
  SButton,
  SCard,
  SCardHeader,
  SDot,
  SHeaderActions,
  SNotice,
  SSection,
  SStat,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
  Toggle,
} from '@/features/settings/ui/settings-ui';
import { policyActionState, usePolicyThresholdDraft } from './usage-policy-controls';
import { useUsage } from './useUsage';
import {
  type ProviderLegacyFallbackView,
  type ProviderUsageView,
  type UsagePolicyTarget,
  usagePolicyTargetKey,
  type UsageSeverity,
  type UsageWindowPolicyView,
  type UsageWindowView,
} from './usage-vm';

const MONO = "'IBM Plex Mono',monospace";

const SEVERITY_FILL: Record<UsageSeverity, string> = {
  normal: 'var(--proto-accent)',
  warning: 'var(--proto-amber)',
  danger: 'var(--proto-danger)',
};

const META_TEXT: CSSProperties = { font: `400 12px/1.5 ${MONO}`, color: 'var(--proto-muted-2)', overflowWrap: 'anywhere' };
const POLICY_TEXT: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: 'var(--proto-muted)', overflowWrap: 'anywhere' };
// The kit control scale, widened on the right only: the `%` suffix is painted over the field.
const POLICY_INPUT: CSSProperties = { ...S_CONTROL_STYLE, width: 84, paddingRight: 24 };
const POLICY_INPUT_DISABLED: CSSProperties = { ...S_CONTROL_DISABLED_STYLE, width: 84, paddingRight: 24 };

function isoTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function targetKey(target: UsagePolicyTarget): string {
  return usagePolicyTargetKey(target);
}

function Observation({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  if (provider.observedAt === null || provider.observedAgo === null) return null;
  const timestamp = isoTime(provider.observedAt);
  return (
    <span>
      {L.usageObserved}{' '}
      <time dateTime={timestamp} title={timestamp}>{provider.observedAgo} {L.usageAgo}</time>
    </span>
  );
}

function ProviderHeader({ provider }: { provider: ProviderUsageView }) {
  return (
    <div data-usage-provider={provider.provider} data-usage-billing={provider.billing ?? ''}>
      <SCardHeader
        title={provider.displayName}
        right={(
          <span style={{ ...META_TEXT, display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span>{provider.modes.join(' · ')}</span>
            <Observation provider={provider} />
          </span>
        )}
      />
    </div>
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
        data-usage-threshold-input={targetKey(props.target)}
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
      <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', font: `500 12px ${MONO}`, color: 'var(--proto-muted-2)' }}>%</span>
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
  const key = targetKey(props.policy.target);
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
    <div data-usage-policy-error={targetKey(target)} style={{ ...POLICY_TEXT, color: 'var(--proto-danger)', marginTop: 8 }}>
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
      type="button" data-usage-policy-expand={targetKey(policy.target)} aria-expanded={props.open}
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
  const key = targetKey(props.policy.target);
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
      <Toggle on={props.policy.enabled} onClick={onToggle} ariaLabel={`Usage throttle ${key}`} inert={state.disabled} />
      <span style={{ ...META_TEXT, marginLeft: 4 }}>{L.usagePolicyThreshold}</span>
      <ThresholdField disabled={state.disabled} target={props.policy.target} value={draft} onChange={setDraft}
        onSubmit={() => saveThreshold(buttons)} />
      <PolicyThresholdButtons {...buttons} />
    </div>
  );
}

function WindowFootnote(props: { window: UsageWindowView; usage: ReturnType<typeof useUsage> }) {
  const [expanded, setExpanded] = useState(false);
  const { policy } = props.window;
  const error = policy ? props.usage.getPolicyError(policy.target) : null;
  const open = expanded || error !== null;
  const reset = <ResetLine window={props.window} />;
  if (!policy) return reset;
  return (
    <div
      data-usage-policy-row={targetKey(policy.target)} data-usage-policy-provider={policy.target.provider}
      data-usage-policy-window-type={policy.target.windowType ?? ''} data-usage-policy-window-label={policy.target.windowLabel ?? ''}
    >
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        {reset}
        <PolicySummary policy={policy} open={open} onToggle={() => setExpanded(!open)} />
      </div>
      {open
        ? (
          <PolicyEditor
            policy={policy} controlsState={props.usage.policyControlsState}
            isPolicySaving={props.usage.isPolicySaving} onSavePolicy={props.usage.savePolicy}
          />
        )
        : null}
      {error ? <PolicyError target={policy.target} message={error.message} /> : null}
    </div>
  );
}

function WindowStat(props: { window: UsageWindowView; usage: ReturnType<typeof useUsage> }) {
  const L = useVocab();
  const view = props.window;
  const detailed = view.policy !== null || view.resetsAt !== null;
  return (
    <div className="settings-usage-window" data-usage-window={view.type} data-usage-severity={view.severity}>
      <SStat
        value={view.utilizationLabel ?? L.usageUnavailable}
        caption={view.label}
        percent={view.utilization === null ? undefined : view.utilization * 100}
        tone={SEVERITY_FILL[view.severity]}
        marker={view.policy?.enabled ? view.policy.thresholdPercent : undefined}
        footnote={detailed ? <WindowFootnote window={view} usage={props.usage} /> : undefined}
      />
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

function QuotaBlock({ provider, usage }: { provider: ProviderUsageView; usage: ReturnType<typeof useUsage> }) {
  const L = useVocab();
  if (provider.quotaState === 'unsupported') return null;
  return (
    <section data-usage-quota={provider.provider} data-usage-quota-state={provider.quotaState} style={{ padding: '14px 16px' }}>
      <SSection label={L.usageQuota}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {provider.quotaState === 'available'
            ? (
              <div className="settings-adaptive-cards settings-usage-windows">
                {provider.windows.map((window) => (
                  <WindowStat
                    key={`${window.type}:${window.label}:${window.resetsAt ?? 'none'}`}
                    window={window} usage={usage}
                  />
                ))}
              </div>
            )
            : <SNotice tone="muted">{L.usageNeverObserved}</SNotice>}
          {provider.legacyFallback
            ? (
              <LegacyFallbackNotice
                fallback={provider.legacyFallback}
                isPolicySaving={usage.isPolicySaving}
                getPolicyError={usage.getPolicyError}
                onSavePolicy={usage.savePolicy}
              />
            )
            : null}
        </div>
      </SSection>
    </section>
  );
}

function SpendBlock({ provider }: { provider: ProviderUsageView }) {
  const L = useVocab();
  if (!provider.spend) return null;
  return (
    <section data-usage-spend={provider.provider} style={{ borderTop: '1px solid var(--proto-line-2)', padding: '14px 16px' }}>
      <SSection label={L.usageGatewaySpend}>
        <div className="settings-adaptive-cards settings-usage-spend">
          <SStat value={provider.spend.today} caption={L.usageToday} />
          <SStat value={provider.spend.month} caption={L.usageMonth} />
        </div>
      </SSection>
    </section>
  );
}

function NoteBlock({ provider }: { provider: ProviderUsageView }) {
  if (!provider.note || provider.noteTone !== 'error') return null;
  return (
    <div style={{ padding: '0 16px 14px' }}>
      <SNotice tone="danger" data-usage-note="error" icon={<SDot color="var(--proto-danger)" size={6} />}>
        {provider.note}
      </SNotice>
    </div>
  );
}

function ProviderCard({ provider, usage }: { provider: ProviderUsageView; usage: ReturnType<typeof useUsage> }) {
  return (
    <SCard>
      <ProviderHeader provider={provider} />
      <QuotaBlock provider={provider} usage={usage} />
      <SpendBlock provider={provider} />
      <NoteBlock provider={provider} />
    </SCard>
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
  // One column of provider cards; each card lays its quota windows out as an adaptive grid.
  return (
    <div data-usage-cards style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {usage.view.providers.map((provider) => <ProviderCard key={provider.key} provider={provider} usage={usage} />)}
    </div>
  );
}

export function UsagePanel() {
  const usage = useUsage();
  return (
    <>
      <SHeaderActions><div data-usage-header><RefreshToolbar usage={usage} /></div></SHeaderActions>
      <UsageContent usage={usage} />
    </>
  );
}
