// input:  context snapshot, manual compact action, modal/surface
// output: shared context bar/modal with compact footer feedback
// pos:    Shared desktop/mobile context usage control
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
    compact: 'Compact context', compacting: 'Compacting…', compacted: 'Context compacted.',
    notNeeded: 'Nothing to compact.', running: 'Stop the current turn before compacting.',
    noHistory: 'No conversation history to compact.',
  },
  zh: {
    title: '上下文用量',
    current: '当前上下文', limit: '上下文上限', usage: '使用率', tokens: 'tokens',
    estimate: '此数值由后端估算。',
    waiting: '下一次 turn 完成后将显示上下文用量。',
    compact: '压缩上下文', compacting: '压缩中…', compacted: '上下文已压缩。',
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
  variant: ContextSurface;
  lang: ContextLanguage;
  compactAction?: ContextCompactAction;
}

export function ContextUsageControl({ usage, supported, variant, lang, compactAction }: ContextUsageControlProps): JSX.Element | null {
  if (!supported && usage === null) return null;
  const copy = COPY[lang];
  const vm = contextUsageViewModel(usage);
  return (
    <Modal
      title={copy.title}
      trigger={(
        <ContextUsageTrigger
          variant={variant}
          percent={vm.percentLabel}
          progress={vm.progress}
          label={copy.usage}
          data-context-compact-enabled={compactAction ? 'true' : undefined}
        />
      )}
      footer={compactAction ? <ContextCompactFooter action={compactAction} lang={lang} /> : undefined}
    >
      <ContextUsageDetails usage={usage} lang={lang} />
    </Modal>
  );
}

interface ContextUsageTriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant: ContextSurface;
  percent: string;
  progress: number | null;
  label: string;
}

const TRIGGER_STYLE: CSSProperties = { border: 0, background: 'transparent', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--proto-muted)', cursor: 'pointer', flex: 'none' };
const PERCENT_STYLE: CSSProperties = { minWidth: 26, font: "600 10px 'IBM Plex Mono', ui-monospace, Menlo, monospace", color: 'var(--proto-muted)', textAlign: 'right', whiteSpace: 'nowrap' };

const ContextUsageTrigger = forwardRef<HTMLButtonElement, ContextUsageTriggerProps>(function ContextUsageTrigger(
  { variant, percent, progress, label, style, ...buttonProps },
  ref,
): JSX.Element {
  return (
    <button {...buttonProps} ref={ref} type="button" data-context-usage-bar={variant} aria-label={`${label}: ${percent}`} style={{ ...TRIGGER_STYLE, ...style }}>
      <span
        data-context-usage-track={variant}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress ?? undefined}
        style={{ display: 'block', width: variant === 'desktop' ? 64 : 48, height: 4, borderRadius: 999, background: 'var(--proto-line-3)', overflow: 'hidden' }}
      >
        <span style={{ display: 'block', height: '100%', width: `${progress ?? 0}%`, borderRadius: 999, background: 'var(--proto-accent)' }} />
      </span>
      <span style={PERCENT_STYLE}>{percent}</span>
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
