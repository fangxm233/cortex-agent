// input:  shared usage hook, provider usage view, row policy state, and localized copy
// output: desktop Usage header, provider cards, inline threshold controls, and spend
// pos:    Independently queried desktop usage settings panel
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { CSSProperties, ReactNode } from 'react';
import { useVocab } from '@/i18n';
import {
  SButton,
  SCard,
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

const SECTION_LABEL: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '.07em',
  color: 'var(--proto-muted-3)',
  textTransform: 'uppercase',
};

const META_TEXT: CSSProperties = { font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' };
const POLICY_TEXT: CSSProperties = { fontSize: 9.5, lineHeight: 1.55, color: 'var(--proto-muted-2)' };
const POLICY_INPUT: CSSProperties = { ...S_CONTROL_STYLE, width: 84, paddingRight: 24 };
const POLICY_INPUT_DISABLED: CSSProperties = { ...S_CONTROL_DISABLED_STYLE, width: 84, paddingRight: 24 };

function isoTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function targetKey(target: UsagePolicyTarget): string {
  return usagePolicyTargetKey(target);
}

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
  const timestamp = isoTime(provider.observedAt);
  return (
    <span style={META_TEXT}>
      {L.usageObserved}{' '}
      <time dateTime={timestamp} title={timestamp}>{provider.observedAgo} {L.usageAgo}</time>
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
      <div style={{ width: window.utilizationWidth, height: '100%', borderRadius: 999, background: SEVERITY_FILL[window.severity] }} />
    </div>
  );
}

function ResetLine({ window }: { window: UsageWindowView }) {
  const L = useVocab();
  if (window.resetElapsed) return <div style={{ ...META_TEXT, marginTop: 4 }}>{L.usageResetElapsed}</div>;
  if (window.resetsAt === null || window.resetIn === null) return null;
  const timestamp = isoTime(window.resetsAt);
  return (
    <div style={{ ...META_TEXT, marginTop: 4 }}>
      {L.usageResetsIn}{' '}<time dateTime={timestamp} title={timestamp}>{window.resetIn}</time>
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
      <span style={{ position: 'absolute', right: 8, top: 6, font: `500 10px ${MONO}`, color: 'var(--proto-muted-2)' }}>%</span>
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
    <div data-usage-policy-controls={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
      <Toggle on={props.policy.enabled} onClick={onClick} ariaLabel={`Usage throttle ${key}`} inert={props.disabled} />
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.usagePolicyEnabled}</span>
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

function PolicyThresholdButtons(props: PolicyThresholdButtonsProps) {
  const L = useVocab();
  const key = targetKey(props.policy.target);
  return (
    <>
      <SButton
        tone="neutral"
        data-usage-threshold-save={key}
        disabled={props.saveDisabled}
        onClick={() => props.parsedThreshold !== null && props.onSavePolicy(props.policy.target, {
          enabled: props.policy.enabled,
          thresholdPercent: props.parsedThreshold,
        })}
      >
        {props.pending ? L.usagePolicySaving : L.usagePolicySave}
      </SButton>
      <SButton
        tone="neutral"
        data-usage-threshold-reset={key}
        aria-label={L.usagePolicyResetDefault}
        title={L.usagePolicyResetDefault}
        disabled={props.resetDisabled}
        onClick={() => props.onSavePolicy(props.policy.target, {
          enabled: true,
          thresholdPercent: null,
        })}
      >
        <ResetIcon />
      </SButton>
    </>
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
      style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--proto-line-3)' }}
    >
      <div style={POLICY_TEXT}>{L.usagePolicyTitle}</div>
      <PolicyControlsRow
        policy={props.policy} disabled={state.disabled} draft={draft} setDraft={setDraft}
        pending={pending} parsedThreshold={parsedThreshold}
        saveDisabled={state.saveDisabled} resetDisabled={state.resetDisabled}
        onSavePolicy={props.onSavePolicy}
      />
      {error ? <div data-usage-policy-error={targetKey(props.policy.target)} style={{ ...POLICY_TEXT, color: 'var(--proto-danger)', marginTop: 7 }}>{error.message}</div> : null}
    </div>
  );
}

function WindowRow(props: { window: UsageWindowView; usage: ReturnType<typeof useUsage> }) {
  const L = useVocab();
  return (
    <div data-usage-window={props.window.type} data-usage-severity={props.window.severity} style={{ marginTop: 11 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-ink-2)' }}>{props.window.label}</span>
        {props.window.utilizationLabel !== null
          ? <span style={{ marginLeft: 'auto', font: `600 14px ${MONO}`, color: 'var(--proto-ink)', letterSpacing: '-.02em' }}>{props.window.utilizationLabel}</span>
          : <span style={{ marginLeft: 'auto', font: `500 10px ${MONO}`, color: 'var(--proto-muted-2)' }}>{L.usageUnavailable}</span>}
      </div>
      <UsageMeter window={props.window} />
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
    <div data-usage-legacy-fallback={props.fallback.target.provider} style={{ marginTop: 10, border: '1px solid var(--proto-line-3)', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.usagePolicyLegacyTitle}</div>
      <div style={{ ...POLICY_TEXT, marginTop: 3 }}>{L.usagePolicyLegacyBody}</div>
      <div style={{ ...POLICY_TEXT, marginTop: 3 }}>{`${props.fallback.enabled ? L.usagePolicyEnabled : L.usagePolicyDisabled} · ${props.fallback.thresholdPercent}%`}</div>
      <div style={{ marginTop: 8 }}>
        <SButton
          tone="neutral"
          data-usage-legacy-clear={props.fallback.target.provider}
          disabled={pending}
          onClick={() => props.onSavePolicy(props.fallback.target, { enabled: true, thresholdPercent: null })}
        >
          {pending ? L.usagePolicySaving : L.usagePolicyClearLegacy}
        </SButton>
      </div>
      {error ? <div data-usage-policy-error={targetKey(props.fallback.target)} style={{ ...POLICY_TEXT, color: 'var(--proto-danger)', marginTop: 7 }}>{error.message}</div> : null}
    </div>
  );
}

function QuotaBlock({ provider, usage }: { provider: ProviderUsageView; usage: ReturnType<typeof useUsage> }) {
  const L = useVocab();
  if (provider.quotaState === 'unsupported') return null;
  return (
    <section data-usage-quota={provider.provider} data-usage-quota-state={provider.quotaState} style={{ padding: '10px 14px 13px', flex: 1 }}>
      <div style={SECTION_LABEL}>{L.usageQuota}</div>
      {provider.quotaState === 'available'
        ? provider.windows.map((window) => <WindowRow key={`${window.type}:${window.label}:${window.resetsAt ?? 'none'}`} window={window} usage={usage} />)
        : <QuietState>{L.usageNeverObserved}</QuietState>}
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

function ProviderCard({ provider, usage }: { provider: ProviderUsageView; usage: ReturnType<typeof useUsage> }) {
  return (
    <SCard style={{ display: 'flex', flexDirection: 'column' }}>
      <CardHeader provider={provider} />
      <QuotaBlock provider={provider} usage={usage} />
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
      {usage.refreshError ? <span style={{ fontSize: 10, color: 'var(--proto-danger)' }}>{L.usageRefreshError}: {usage.refreshError.message}</span> : null}
      <SButton tone="neutral" data-usage-refresh aria-busy={usage.isRefreshing} onClick={usage.refresh}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshIcon spinning={usage.isRefreshing} />
          {usage.isRefreshing ? L.usageRefreshing : L.usageRefresh}
        </span>
      </SButton>
    </div>
  );
}

function UsageContent({ usage }: { usage: ReturnType<typeof useUsage> }) {
  const L = useVocab();
  if (usage.isLoading) return <div style={{ marginTop: 16, fontSize: 12, color: 'var(--proto-muted-3)' }}>{L.usageLoading}</div>;
  if (usage.queryError) return <div style={{ marginTop: 16 }}><ErrorChip label={L.usageLoadError} message={usage.queryError.message} /></div>;
  if (usage.view.providers.length === 0) {
    return <div style={{ marginTop: 14, maxWidth: 420 }}><QuietState>{L.usageEmpty}</QuietState></div>;
  }
  return (
    <div style={{ marginTop: 12, display: 'grid', gap: 12, alignItems: 'start', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}>
      {usage.view.providers.map((provider) => <ProviderCard key={provider.provider} provider={provider} usage={usage} />)}
    </div>
  );
}

export function UsagePanel() {
  const L = useVocab();
  const usage = useUsage();
  return (
    <div style={{ maxWidth: 980 }}>
      <div data-usage-header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.stNavUsage}</div>
        <div style={{ marginLeft: 'auto' }}><RefreshToolbar usage={usage} /></div>
      </div>
      <UsageContent usage={usage} />
    </div>
  );
}
