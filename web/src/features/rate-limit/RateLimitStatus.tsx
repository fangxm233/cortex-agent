// input:  active rate-limit view model and desktop/mobile open-close callbacks
// output: throttle controls with provider wait counts and reset details
// pos:    Shared active-only provider rate-limit presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { forwardRef } from 'react';
import { Popover } from '@/design/Popover';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import type { RateLimitView } from './rate-limit-vm';

interface StatusProps {
  status: RateLimitView | null;
}

const DesktopTrigger = forwardRef<HTMLButtonElement, { label: string }>(function DesktopTrigger(
  { label },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
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
            <span style={{ marginLeft: 'auto', font: `600 9px ${MONO}`, color: amber }}>
              {provider.recoveryCountdown}
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
