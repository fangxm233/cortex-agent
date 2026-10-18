import { forwardRef, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';
import type { SessionContextUsage } from '@cortex-agent/ui-contract';
import { Button } from '@/design/Button';
import { Modal } from '@/design/Modal';
import { useVocabOptional, type Vocab } from '@/i18n';
import { contextUsageViewModel } from './context-usage';

type ContextSurface = 'desktop' | 'mobile';

export type ContextCompactDisabledReason = 'running' | 'no-history' | null;

export interface ContextCompactAction {
  onCompact: () => void;
  pending: boolean;
  disabled: boolean;
  status: 'compacted' | 'not-needed' | null;
  error: string | null;
  disabledReason: ContextCompactDisabledReason;
}

export interface ContextUsageControlProps {
  usage: SessionContextUsage | null;
  compactAction?: ContextCompactAction;
}

export function ContextUsageControl({ usage, compactAction }: ContextUsageControlProps): JSX.Element {
  const L = useVocabOptional();
  return (
    <Modal
      title={L.chatCtxTitle}
      trigger={(
        <ContextUsageRing
          usage={usage}
          variant="desktop"
          data-context-compact-enabled={compactAction ? 'true' : undefined}
        />
      )}
      footer={compactAction ? <ContextCompactFooter action={compactAction} /> : undefined}
    >
      <ContextUsageDetails usage={usage} />
    </Modal>
  );
}

export interface ContextUsageRingProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  usage: SessionContextUsage | null;
  variant: ContextSurface;
}

const TRIGGER_STYLE: CSSProperties = { borderRadius: 'var(--r-pill)', border: 0, background: 'transparent', padding: 0, display: 'inline-flex', alignItems: 'center', color: 'var(--proto-muted)', cursor: 'pointer', flex: 'none' };

/** The filled share of the gauge as a pie wedge from twelve o'clock, clockwise; null when empty. A
 *  full context is the whole disc (an arc of 360° has no path). */
export function contextWedgePath(progress: number | null, center: number, radius: number): string | null {
  if (progress == null || progress <= 0) return null;
  const share = Math.min(progress, 100) / 100;
  if (share >= 1) {
    return `M ${center} ${center - radius} A ${radius} ${radius} 0 1 1 ${center} ${center + radius} A ${radius} ${radius} 0 1 1 ${center} ${center - radius} Z`;
  }
  const angle = share * 2 * Math.PI;
  const x = center + radius * Math.sin(angle);
  const y = center - radius * Math.cos(angle);
  const large = share > 0.5 ? 1 : 0;
  const fixed = (n: number): string => n.toFixed(2);
  return `M ${center} ${center} L ${center} ${fixed(center - radius)} A ${radius} ${radius} 0 ${large} 1 ${fixed(x)} ${fixed(y)} Z`;
}

/** Compact circular usage gauge — the toolbar form of context usage: the desktop composer row, and
 *  on mobile the composer's action row beside Send. The percent lives in the tooltip/aria label
 *  rather than beside the ring, so the control stays icon-sized. It is drawn as a pie: a hairline
 *  ring on a faint disc with a filled wedge of muted ink. A stroked arc would read as a loading
 *  spinner sitting next to Send and Stop; a filled share reads as a gauge. Muted, not accent: how
 *  full the context is is reference, not a state the accent should announce. Callers may restyle
 *  it through `style` — it is the button itself, so do not wrap it in one. */
export const ContextUsageRing = forwardRef<HTMLButtonElement, ContextUsageRingProps>(function ContextUsageRing(
  { usage, variant, style, className, ...buttonProps },
  ref,
): JSX.Element {
  const L = useVocabOptional();
  const vm = contextUsageViewModel(usage);
  const size = variant === 'desktop' ? 20 : 22;
  const center = size / 2;
  const wedge = contextWedgePath(vm.progress, center, center - 3.5);
  // Named as context, not bare "usage": beside the top bar's usage (spend) button the bare word
  // reads as money.
  const label = `${L.chatCtxTitle}: ${vm.percentLabel}`;
  return (
    <button {...buttonProps} ref={ref} className={`${MENU_FOCUS} ${className ?? ''}`} type="button" data-context-usage-ring={variant} data-context-usage-presentation={variant === 'mobile' ? 'sheet-trigger' : 'modal-trigger'} aria-label={label} title={label} style={{ ...TRIGGER_STYLE, ...style }}>
      <span
        data-context-usage-track={variant}
        role="progressbar"
        aria-label={L.chatCtxTitle}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={vm.progress ?? undefined}
        style={{ display: 'inline-flex' }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle cx={center} cy={center} r={center - 1} fill="var(--proto-gray)" stroke="var(--proto-line-3)" strokeWidth={1.25} />
          {wedge && <path data-context-usage-wedge="" d={wedge} fill="var(--proto-muted)" />}
        </svg>
      </span>
    </button>
  );
});

function compactFeedback(action: ContextCompactAction, L: Vocab): string | null {
  if (action.error) return action.error;
  if (action.status === 'compacted') return L.chatCtxCompacted;
  if (action.status === 'not-needed') return L.chatCtxNotNeeded;
  if (action.disabledReason === 'running') return L.chatCtxRunning;
  if (action.disabledReason === 'no-history') return L.chatCtxNoHistory;
  return null;
}

export function ContextCompactFooter({
  action,
}: { action: ContextCompactAction }): JSX.Element {
  const L = useVocabOptional();
  return (
    <>
      <span aria-live="polite" style={{ marginRight: 'auto', color: 'var(--proto-muted)', fontSize: 12 }}>
        {compactFeedback(action, L)}
      </span>
      <Button
        data-context-compact-action
        variant="primary"
        size="sm"
        disabled={action.pending || action.disabled}
        onClick={action.onCompact}
      >
        {action.pending ? L.chatCtxCompacting : L.chatCtxCompact}
      </Button>
    </>
  );
}

export function ContextUsageDetails({ usage }: { usage: SessionContextUsage | null }): JSX.Element {
  const L = useVocabOptional();
  const vm = contextUsageViewModel(usage);
  const rows = [
    [L.chatCtxCurrent, vm.current === '—' ? vm.current : `${vm.current} ${L.chatCtxTokens}`],
    [L.chatCtxLimit, vm.maximum === '—' ? vm.maximum : `${vm.maximum} ${L.chatCtxTokens}`],
    [L.chatCtxUsage, vm.percentLabel],
  ];
  const note = usage ? (vm.estimated ? L.chatCtxEstimate : null) : L.chatCtxWaiting;
  return (
    <div data-context-usage-details style={{ display: 'grid', gap: 10 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 20, borderBottom: '1px solid var(--proto-line-2)', paddingBottom: 8 }}>
          <span style={{ color: 'var(--proto-muted)' }}>{label}</span>
          <span style={{ fontWeight: 550, fontVariantNumeric: 'tabular-nums', color: 'var(--proto-ink)', textAlign: 'right' }}>{value}</span>
        </div>
      ))}
      {note ? (
        <p style={{ margin: 0, color: 'var(--proto-muted)', fontSize: 12, lineHeight: 1.5 }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
