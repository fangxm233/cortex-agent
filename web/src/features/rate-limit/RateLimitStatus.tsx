// input:  active rate-limit view model and desktop/mobile open-close callbacks
// output: throttle controls with provider wait counts, reset details, and early-clear buttons
// pos:    Shared active-only provider rate-limit presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { Popover } from '@/design/Popover';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import type { Lang } from '@/i18n';
import type { RateLimitView } from './rate-limit-vm';

interface StatusProps {
  status: RateLimitView | null;
}

// Radix Popover.Trigger (asChild) injects its interaction props (onClick, aria-*, data-state)
// into this element — they MUST be spread onto the real <button> or the popover never opens.
const DesktopTrigger = forwardRef<
  HTMLButtonElement,
  { label: string } & ButtonHTMLAttributes<HTMLButtonElement>
>(function DesktopTrigger({ label, ...triggerProps }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...triggerProps}
      aria-label="Rate limit status"
      title={label}
      style={{
        border: '1px solid var(--pill-waiting-bg)',
        background: 'var(--pill-waiting-bg)',
        color: 'var(--pill-waiting-fg)',
        borderRadius: 999,
        padding: '3px 7px',
        maxWidth: 178,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        font: "600 9px 'IBM Plex Mono',monospace",
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
});

export function DesktopRateLimitStatus({ status }: StatusProps): JSX.Element | null {
  if (!status) return null;
  return (
    <Popover trigger={<DesktopTrigger label={status.label} />} side="bottom" align="end">
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

/** Lifts the provider's throttle early via system.clearRateLimit; refreshes the status query. */
function ClearRateLimitButton({ provider, lang, mobile = false }: { provider: string; lang: Lang; mobile?: boolean }): JSX.Element {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const clearMut = useMutation({
    ...trpc.system.clearRateLimit.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.system.rateLimitStatus.queryFilter());
      },
    }),
  });
  const busy = clearMut.isPending;
  const border = mobile ? MC.amberBorder : 'var(--pill-waiting-bg)';
  const color = mobile ? MC.amberText : 'var(--pill-waiting-fg)';
  return (
    <button
      type="button"
      disabled={busy}
      title={lang === 'zh' ? '立即结束此限流，恢复等待中的工作' : 'Lift this rate limit now and resume paused work'}
      onClick={() => clearMut.mutate({ provider })}
      style={{
        border: `1px solid ${border}`,
        background: 'transparent',
        color,
        borderRadius: 999,
        padding: '2px 8px',
        font: "600 9px 'IBM Plex Mono',monospace",
        cursor: busy ? 'progress' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {clearButtonCopy(lang, busy)}
    </button>
  );
}

export function RateLimitDetails({
  status,
  mobile = false,
}: { status: RateLimitView; mobile?: boolean }): JSX.Element {
  const copy = detailsCopy(status);
  const ink = mobile ? MC.ink : 'var(--proto-ink)';
  const muted = mobile ? MC.muted : 'var(--proto-muted-2)';
  const line = mobile ? MC.hairline : 'var(--proto-line)';
  const amber = mobile ? MC.amberText : 'var(--pill-waiting-fg)';
  return (
    <div style={{ minWidth: mobile ? 0 : 230, color: ink }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{copy.title}</div>
      {status.providers.map((provider, providerIndex) => (
        <div
          key={provider.provider}
          style={{
            borderTop: providerIndex > 0 ? `1px solid ${line}` : 'none',
            paddingTop: providerIndex > 0 ? 9 : 0,
            marginTop: providerIndex > 0 ? 9 : 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700 }}>{provider.displayName}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <ClearRateLimitButton provider={provider.provider} lang={status.lang} mobile={mobile} />
              <span style={{ font: `600 9px ${MONO}`, color: amber }}>{provider.recoveryCountdown}</span>
            </span>
          </div>
          <div style={{ marginTop: 4, color: muted, font: `500 9px ${MONO}` }}>
            {provider.waitingLabel}
          </div>
          {provider.windows.map((window) => (
            <div
              key={`${window.type}:${window.resetsAt}`}
              style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, color: muted }}
            >
              <span style={{ font: `600 9.5px ${MONO}` }}>{window.typeLabel}</span>
              <span style={{ marginLeft: 'auto', font: `500 9.5px ${MONO}` }}>
                {window.countdown} {copy.recovers}
              </span>
            </div>
          ))}
        </div>
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
