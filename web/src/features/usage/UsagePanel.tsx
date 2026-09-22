import type { CSSProperties, ReactNode } from 'react';
import { useVocab } from '@/i18n';
import {
  SButton,
  SCard,
  SCardHeader,
  SDot,
  SNotice,
  SSection,
  SStat,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
  Toggle,
} from '@/features/settings/settings-ui';
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

const META_TEXT: CSSProperties = { font: `400 10.5px ${MONO}`, color: 'var(--proto-muted-3)' };
const POLICY_TEXT: CSSProperties = { fontSize: 11.5, lineHeight: 1.5, color: 'var(--proto-muted-2)' };
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
          <span style={{ ...META_TEXT, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
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
}) {
  return (
    <div style={{ position: 'relative', width: 84 }}>
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
        style={props.disabled ? POLICY_INPUT_DISABLED : POLICY_INPUT}
      />
      <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', font: `500 10.5px ${MONO}`, color: 'var(--proto-muted-2)' }}>%</span>
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

interface WindowPolicyBlockProps {
  policy: UsageWindowPolicyView;
  controlsState: ReturnType<typeof useUsage>['policyControlsState'];
  isPolicySaving: PendingPolicyGetter;
  getPolicyError: PolicyErrorGetter;
  onSavePolicy: SavePolicyHandler;
}

function PolicyControlsRow(props: PolicyThresholdButtonsProps & {
  disabled: boolean;
  draft: string;
  setDraft: (value: string) => void;
}) {
  const L = useVocab();
  const key = targetKey(props.policy.target);
  const onClick = props.disabled
    ? undefined
    : () => props.onSavePolicy(props.policy.target, {
        enabled: !props.policy.enabled,
        thresholdPercent: props.policy.thresholdPercent,
      });
  return (
    <div data-usage-policy-controls={key} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
      <Toggle on={props.policy.enabled} onClick={onClick} ariaLabel={`Usage throttle ${key}`} inert={props.disabled} />
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.usagePolicyEnabled}</span>
      <span style={{ ...META_TEXT, marginLeft: 4 }}>{L.usagePolicyThreshold}</span>
      <ThresholdField disabled={props.disabled} target={props.policy.target} value={props.draft} onChange={props.setDraft} />
      <PolicyThresholdButtons {...props} />
    </div>
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

function saveThreshold(props: PolicyThresholdButtonsProps): void {
  if (props.parsedThreshold === null) return;
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

function WindowPolicyBlock(props: WindowPolicyBlockProps) {
  const L = useVocab();
  const pending = props.isPolicySaving(props.policy.target);
  const error = props.getPolicyError(props.policy.target);
  const { draft, parsedThreshold, setDraft } = usePolicyThresholdDraft(props.policy);
  const state = policyActionState(props.controlsState !== 'ready', pending, parsedThreshold, props.policy);
  return (
    <div
      data-usage-policy-row={targetKey(props.policy.target)} data-usage-policy-provider={props.policy.target.provider}
      data-usage-policy-window-type={props.policy.target.windowType ?? ''} data-usage-policy-window-label={props.policy.target.windowLabel ?? ''}
      style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--proto-line-2)' }}
    >
      <div style={POLICY_TEXT}>{L.usagePolicyTitle}</div>
      <PolicyControlsRow
        policy={props.policy} disabled={state.disabled} draft={draft} setDraft={setDraft}
        pending={pending} parsedThreshold={parsedThreshold}
        saveDisabled={state.saveDisabled} resetDisabled={state.resetDisabled}
        onSavePolicy={props.onSavePolicy}
      />
      {error ? <PolicyError target={props.policy.target} message={error.message} /> : null}
    </div>
  );
}

function WindowFootnote(props: { window: UsageWindowView; usage: ReturnType<typeof useUsage> }) {
  return (
    <>
      <ResetLine window={props.window} />
      {props.window.policy
        ? (
          <WindowPolicyBlock
            policy={props.window.policy}
            controlsState={props.usage.policyControlsState}
            isPolicySaving={props.usage.isPolicySaving}
            getPolicyError={props.usage.getPolicyError}
            onSavePolicy={props.usage.savePolicy}
          />
        )
        : null}
    </>
  );
}

function WindowStat(props: { window: UsageWindowView; usage: ReturnType<typeof useUsage> }) {
  const L = useVocab();
  const view = props.window;
  const detailed = view.policy !== null || view.resetsAt !== null;
  return (
    <div data-usage-window={view.type} data-usage-severity={view.severity}>
      <SStat
        value={view.utilizationLabel ?? L.usageUnavailable}
        caption={view.label}
        percent={view.utilization === null ? undefined : view.utilization * 100}
        tone={SEVERITY_FILL[view.severity]}
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
            ? provider.windows.map((window) => (
              <WindowStat
                key={`${window.type}:${window.label}:${window.resetsAt ?? 'none'}`}
                window={window} usage={usage}
              />
            ))
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
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
      {usage.refreshError ? <span style={{ fontSize: 11.5, color: 'var(--proto-danger)' }}>{L.usageRefreshError}: {usage.refreshError.message}</span> : null}
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
  if (usage.isLoading) return <div style={{ fontSize: 12, color: 'var(--proto-muted-3)' }}>{L.usageLoading}</div>;
  if (usage.queryError) {
    return (
      <SNotice tone="danger" icon={<SDot color="var(--proto-danger)" size={6} />}>
        {L.usageLoadError}: {usage.queryError.message}
      </SNotice>
    );
  }
  if (usage.view.providers.length === 0) return <SNotice tone="muted">{L.usageEmpty}</SNotice>;
  // One column: a quota window now carries its throttle controls inline (toggle, threshold field
  // and two buttons need ~370px), which a 400px masonry column cannot hold without wrapping them.
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
      <div data-usage-header><RefreshToolbar usage={usage} /></div>
      <UsageContent usage={usage} />
    </>
  );
}
