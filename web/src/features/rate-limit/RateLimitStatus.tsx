// input:  active rate-limit view model and desktop/mobile open-close callbacks
// output: throttle controls with wait counts, labeled resets, and early-clear buttons
// pos:    Shared active-only provider rate-limit presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { forwardRef, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { Popover } from '@/design/Popover';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import type { Lang } from '@/i18n';
import type { RateLimitProviderView, RateLimitView } from './rate-limit-vm';

interface StatusProps {
  status: RateLimitView | null;
}

// Radix Popover.Trigger (asChild) injects its interaction props (onClick, aria-*, data-state)
// into this element — they MUST be spread onto the real <button> or the popover never opens.
//
// Rail banner trigger — the left rail stacks throttle and approvals in one attention zone above the
// footer, so this keeps the approvals banner's SHAPE (full-width row, pulsing dot, label) while
// carrying the waiting tokens, which is what distinguishes "wait it out" from "act on it".
const RailBannerTrigger = forwardRef<
  HTMLButtonElement,
  { label: string } & ButtonHTMLAttributes<HTMLButtonElement>
>(function RailBannerTrigger({ label, ...triggerProps }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...triggerProps}
      aria-label="Rate limit status"
      title={label}
      style={{
        width: '100%',
        padding: '9px 12px',
        border: '1px solid var(--pill-waiting-bg)',
        background: 'var(--pill-waiting-bg)',
        color: 'var(--pill-waiting-fg)',
        borderRadius: 9,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        textAlign: 'left',
        font: "600 10px 'IBM Plex Mono',monospace",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--pill-waiting-fg)',
          flex: 'none',
          animation: 'cxpulse 2s ease-in-out infinite',
        }}
      />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </button>
  );
});

export function RailRateLimitStatus({ status }: StatusProps): JSX.Element | null {
  if (!status) return null;
  return (
    <Popover trigger={<RailBannerTrigger label={status.label} />} side="top" align="center">
      <RateLimitDetails status={status} />
    </Popover>
  );
}

export function MobileRateLimitStatus({
  status,
  onOpen,
}: StatusProps & { onOpen: () => void }): JSX.Element | null {
  if (!status) return null;
  return (
    <button
      type="button"
      aria-label="Rate limit status"
      title={status.label}
      onClick={onOpen}
      style={{
        border: `1px solid ${MC.amberBorder}`,
        background: MC.amberBg,
        color: MC.amberText,
        borderRadius: 999,
        padding: '3px 7px',
        maxWidth: 190,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        font: `600 8.5px ${MONO}`,
        cursor: 'pointer',
      }}
    >
      {status.label}
    </button>
  );
}

function detailsCopy(status: RateLimitView): { title: string; recovers: string } {
  return status.lang === 'zh'
    ? { title: '限流详情', recovers: '后恢复' }
    : { title: 'Rate limits', recovers: 'to reset' };
}

function clearButtonCopy(lang: Lang, busy: boolean): string {
  if (lang === 'zh') return busy ? '清除中…' : '立即清除';
  return busy ? 'Clearing…' : 'Clear now';
}

function clearButtonStyle(mobile: boolean, busy: boolean): CSSProperties {
  const border = mobile ? MC.amberBorder : 'var(--pill-waiting-bg)';
  return {
    border: `1px solid ${border}`, background: 'transparent',
    color: mobile ? MC.amberText : 'var(--pill-waiting-fg)', borderRadius: 999,
    padding: '2px 8px', font: "600 9px 'IBM Plex Mono',monospace",
    cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.6 : 1,
  };
}

/** Lifts the provider's throttle early via system.clearRateLimit; refreshes the status query. */
function ClearRateLimitButton({ provider, lang, mobile = false }: { provider: string; lang: Lang; mobile?: boolean }): JSX.Element {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const clearMut = useMutation(trpc.system.clearRateLimit.mutationOptions({
    onSuccess: () => void queryClient.invalidateQueries(trpc.system.rateLimitStatus.queryFilter()),
  }));
  const busy = clearMut.isPending;
  return (
    <button
      type="button" disabled={busy}
      title={lang === 'zh' ? '立即结束此限流，恢复等待中的工作' : 'Lift this rate limit now and resume paused work'}
      onClick={() => clearMut.mutate({ provider })}
      style={clearButtonStyle(mobile, busy)}
    >
      {clearButtonCopy(lang, busy)}
    </button>
  );
}

function ProviderWindows(props: { provider: RateLimitProviderView; recovers: string; muted: string }) {
  return props.provider.windows.map((window) => (
    <div
      key={`${window.type}:${window.typeLabel}:${window.resetsAt}`}
      style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, color: props.muted }}
    >
      <span style={{ font: `600 9.5px ${MONO}` }}>{window.typeLabel}</span>
      <span style={{ marginLeft: 'auto', font: `500 9.5px ${MONO}` }}>
        {window.countdown} {props.recovers}
      </span>
    </div>
  ));
}

function ProviderDetails(props: {
  provider: RateLimitProviderView; index: number; status: RateLimitView; mobile: boolean;
}) {
  const { provider, index, status, mobile } = props;
  const muted = mobile ? MC.muted : 'var(--proto-muted-2)';
  const line = mobile ? MC.hairline : 'var(--proto-line)';
  const amber = mobile ? MC.amberText : 'var(--pill-waiting-fg)';
  return (
    <div style={{ borderTop: index > 0 ? `1px solid ${line}` : 'none', paddingTop: index > 0 ? 9 : 0, marginTop: index > 0 ? 9 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700 }}>{provider.displayName}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ClearRateLimitButton provider={provider.provider} lang={status.lang} mobile={mobile} />
          <span style={{ font: `600 9px ${MONO}`, color: amber }}>{provider.recoveryCountdown}</span>
        </span>
      </div>
      <div style={{ marginTop: 4, color: muted, font: `500 9px ${MONO}` }}>{provider.waitingLabel}</div>
      <ProviderWindows provider={provider} recovers={detailsCopy(status).recovers} muted={muted} />
    </div>
  );
}

export function RateLimitDetails({ status, mobile = false }: { status: RateLimitView; mobile?: boolean }): JSX.Element {
  const copy = detailsCopy(status);
  const ink = mobile ? MC.ink : 'var(--proto-ink)';
  return (
    <div style={{ minWidth: mobile ? 0 : 230, color: ink }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{copy.title}</div>
      {status.providers.map((provider, index) => (
        <ProviderDetails key={provider.provider} provider={provider} index={index} status={status} mobile={mobile} />
      ))}
    </div>
  );
}

export function MobileRateLimitSheet({
  status,
  onClose,
}: { status: RateLimitView; onClose: () => void }): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ padding: '2px 18px 24px' }}>
        <RateLimitDetails status={status} mobile />
      </div>
    </MBottomSheet>
  );
}
