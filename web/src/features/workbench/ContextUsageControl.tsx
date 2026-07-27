// input:  session context snapshot, support flag, language, surface variant
// output: compact clickable progress/percent and current/max modal
// pos:    Shared desktop/mobile context usage control
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { SessionContextUsage } from '@cortex-agent/ui-contract';
import { Modal } from '@/design/Modal';
import { contextUsageViewModel } from './context-usage';

type ContextLanguage = 'en' | 'zh';
type ContextSurface = 'desktop' | 'mobile';

const COPY = {
  en: {
    title: 'Context usage',
    current: 'Current context', limit: 'Context limit', usage: 'Usage', tokens: 'tokens',
    estimate: 'PI reports this value as an estimate.',
    waiting: 'Context usage becomes available after the next PI turn completes.',
  },
  zh: {
    title: '上下文用量',
    current: '当前上下文', limit: '上下文上限', usage: '使用率', tokens: 'tokens',
    estimate: '此数值由 PI 估算。',
    waiting: '下一次 PI turn 完成后将显示上下文用量。',
  },
} as const;

export interface ContextUsageControlProps {
  usage: SessionContextUsage | null;
  supported: boolean;
  variant: ContextSurface;
  lang: ContextLanguage;
}

export function ContextUsageControl({ usage, supported, variant, lang }: ContextUsageControlProps): JSX.Element | null {
  if (!supported && usage === null) return null;
  const copy = COPY[lang];
  const vm = contextUsageViewModel(usage);
  return (
    <Modal
      title={copy.title}
      trigger={<ContextUsageTrigger variant={variant} percent={vm.percentLabel} progress={vm.progress} label={copy.usage} />}
    >
      <ContextUsageDetails usage={usage} lang={lang} />
    </Modal>
  );
}

interface ContextUsageTriggerProps {
  variant: ContextSurface;
  percent: string;
  progress: number | null;
  label: string;
}

function ContextUsageTrigger({ variant, percent, progress, label }: ContextUsageTriggerProps): JSX.Element {
  return (
    <button
      type="button"
      data-context-usage-bar={variant}
      aria-label={`${label}: ${percent}`}
      aria-haspopup="dialog"
      style={{ border: 0, background: 'transparent', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--proto-muted)', cursor: 'pointer', flex: 'none' }}
    >
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
      <span style={{ minWidth: 26, font: "600 10px 'IBM Plex Mono', ui-monospace, Menlo, monospace", color: 'var(--proto-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {percent}
      </span>
    </button>
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
