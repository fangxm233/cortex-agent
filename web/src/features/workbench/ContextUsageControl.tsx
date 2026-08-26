// input:  context snapshot, compact action, modal/surface
// output: shared context ring/details and desktop context modal
// pos:    Cross-surface context usage presentation primitives
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { forwardRef, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import type { SessionContextUsage } from '@cortex-agent/ui-contract';
import { Button } from '@/design/Button';
import { Modal } from '@/design/Modal';
import { contextUsageViewModel } from './context-usage';

type ContextLanguage = 'en' | 'zh';
type ContextSurface = 'desktop' | 'mobile';

const COPY = {
  en: {
    title: 'Context usage',
    current: 'Current context', limit: 'Context limit', usage: 'Usage', tokens: 'tokens',
    estimate: 'The backend reports this value as an estimate.',
    waiting: 'Context usage becomes available after the next turn completes.',
    compact: 'Compact', compacting: 'Compacting…', compacted: 'Context compacted.',
    notNeeded: 'Nothing to compact.', running: 'Stop the current turn before compacting.',
    noHistory: 'No conversation history to compact.',
  },
  zh: {
    title: '上下文用量',
    current: '当前上下文', limit: '上下文上限', usage: '使用率', tokens: 'tokens',
    estimate: '此数值由后端估算。',
    waiting: '下一次 turn 完成后将显示上下文用量。',
    compact: '压缩', compacting: '压缩中…', compacted: '上下文已压缩。',
    notNeeded: '当前没有可压缩内容。', running: '请先停止当前 turn，再压缩上下文。',
    noHistory: '当前没有可压缩的会话历史。',
  },
} as const;

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
  supported: boolean;
  variant: 'desktop';
  lang: ContextLanguage;
  compactAction?: ContextCompactAction;
}

export function contextUsageTitle(lang: ContextLanguage): string {
  return COPY[lang].title;
}

export function ContextUsageControl({ usage, supported, variant, lang, compactAction }: ContextUsageControlProps): JSX.Element | null {
  if (!supported && usage === null) return null;
  return (
    <Modal
      title={contextUsageTitle(lang)}
      trigger={(
        <ContextUsageRing
          usage={usage}
          variant={variant}
          lang={lang}
          data-context-compact-enabled={compactAction ? 'true' : undefined}
        />
      )}
      footer={compactAction ? <ContextCompactFooter action={compactAction} lang={lang} /> : undefined}
    >
      <ContextUsageDetails usage={usage} lang={lang} />
    </Modal>
  );
}

export interface ContextUsageRingProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  usage: SessionContextUsage | null;
  variant: ContextSurface;
  lang: ContextLanguage;
}

const TRIGGER_STYLE: CSSProperties = { border: 0, background: 'transparent', padding: 0, display: 'inline-flex', alignItems: 'center', color: 'var(--proto-muted)', cursor: 'pointer', flex: 'none' };

/** Compact circular usage gauge — the composer-toolbar form of context usage. The percent lives in
 *  the tooltip/aria label rather than beside the ring, so the control stays icon-sized. */
export const ContextUsageRing = forwardRef<HTMLButtonElement, ContextUsageRingProps>(function ContextUsageRing(
  { usage, variant, lang, style, ...buttonProps },
  ref,
): JSX.Element {
  const copy = COPY[lang];
  const vm = contextUsageViewModel(usage);
  const size = variant === 'desktop' ? 20 : 22;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const filled = circumference * ((vm.progress ?? 0) / 100);
  const label = `${copy.usage}: ${vm.percentLabel}`;
  return (
    <button {...buttonProps} ref={ref} type="button" data-context-usage-ring={variant} data-context-usage-presentation={variant === 'mobile' ? 'sheet-trigger' : 'modal-trigger'} aria-label={label} title={label} style={{ ...TRIGGER_STYLE, ...style }}>
      <span
        data-context-usage-track={variant}
        role="progressbar"
        aria-label={copy.usage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={vm.progress ?? undefined}
        style={{ display: 'inline-flex' }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--proto-line-3)" strokeWidth={stroke} />
          {vm.progress != null && vm.progress > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="var(--proto-accent)"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${circumference}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )}
        </svg>
      </span>
    </button>
  );
});

function compactFeedback(action: ContextCompactAction, lang: ContextLanguage): string | null {
  const copy = COPY[lang];
  if (action.error) return action.error;
  if (action.status === 'compacted') return copy.compacted;
  if (action.status === 'not-needed') return copy.notNeeded;
  if (action.disabledReason === 'running') return copy.running;
  if (action.disabledReason === 'no-history') return copy.noHistory;
  return null;
}

export function ContextCompactFooter({
  action,
  lang,
}: { action: ContextCompactAction; lang: ContextLanguage }): JSX.Element {
  const copy = COPY[lang];
  return (
    <>
      <span aria-live="polite" style={{ marginRight: 'auto', color: 'var(--proto-muted)', fontSize: 12 }}>
        {compactFeedback(action, lang)}
      </span>
      <Button
        data-context-compact-action
        variant="primary"
        size="sm"
        disabled={action.pending || action.disabled}
        onClick={action.onCompact}
      >
        {action.pending ? copy.compacting : copy.compact}
      </Button>
    </>
  );
}

export function ContextUsageDetails({ usage, lang }: { usage: SessionContextUsage | null; lang: ContextLanguage }): JSX.Element {
  const copy = COPY[lang];
  const vm = contextUsageViewModel(usage);
  const rows = [
    [copy.current, vm.current === '—' ? vm.current : `${vm.current} ${copy.tokens}`],
    [copy.limit, vm.maximum === '—' ? vm.maximum : `${vm.maximum} ${copy.tokens}`],
    [copy.usage, vm.percentLabel],
  ];
  const note = usage ? (vm.estimated ? copy.estimate : null) : copy.waiting;
  return (
    <div data-context-usage-details style={{ display: 'grid', gap: 10 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 20, borderBottom: '1px solid var(--proto-line-2)', paddingBottom: 8 }}>
          <span style={{ color: 'var(--proto-muted)' }}>{label}</span>
          <span style={{ font: "600 12px 'IBM Plex Mono', ui-monospace, Menlo, monospace", color: 'var(--proto-ink)', textAlign: 'right' }}>{value}</span>
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
