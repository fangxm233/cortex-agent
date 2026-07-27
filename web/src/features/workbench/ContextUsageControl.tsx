// input:  session context snapshot, support flag, language, surface variant
// output: clickable context progress bar and accessible current/max modal
// pos:    Shared desktop/mobile context usage control
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { CSSProperties } from 'react';
import type { SessionContextUsage } from '@cortex-agent/ui-contract';
import { Modal } from '@/design/Modal';
import { contextUsageViewModel } from './context-usage';

type ContextLanguage = 'en' | 'zh';
type ContextSurface = 'desktop' | 'mobile';

const COPY = {
  en: {
    label: 'CONTEXT', unavailable: 'Unavailable', title: 'Context usage',
    current: 'Current context', limit: 'Context limit', usage: 'Usage', tokens: 'tokens',
    estimate: 'PI reports this value as an estimate.',
    waiting: 'Context usage becomes available after the next PI turn completes.',
  },
  zh: {
    label: '上下文', unavailable: '暂不可用', title: '上下文用量',
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
  const wrapperStyle: CSSProperties = variant === 'desktop'
    ? { width: '100%', maxWidth: 756, margin: '0 auto', padding: '0 32px 8px', boxSizing: 'border-box', flex: 'none' }
    : { width: '100%', padding: '0 2px 7px', boxSizing: 'border-box' };

  const trigger = (
    <button
      type="button"
      data-context-usage-bar={variant}
      aria-label={`${copy.title}: ${vm.compact}`}
      aria-haspopup="dialog"
      style={{
        width: '100%', border: '1px solid var(--proto-line-3)', background: 'var(--proto-card)',
        borderRadius: variant === 'mobile' ? 11 : 10, padding: variant === 'mobile' ? '7px 10px' : '7px 11px',
        display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 9,
        color: 'var(--proto-ink)', cursor: 'pointer', boxSizing: 'border-box', textAlign: 'left',
      }}
    >
      <span style={{ font: "600 10px 'IBM Plex Mono', ui-monospace, Menlo, monospace", letterSpacing: '.04em', color: 'var(--proto-muted)' }}>
        {copy.label}
      </span>
      <span
        role="progressbar"
        aria-label={copy.usage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={vm.progress ?? undefined}
        style={{ height: 5, borderRadius: 999, background: 'var(--proto-accent-bg)', overflow: 'hidden' }}
      >
        <span style={{ display: 'block', height: '100%', width: `${vm.progress ?? 0}%`, borderRadius: 999, background: 'var(--proto-accent)' }} />
      </span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 7, whiteSpace: 'nowrap' }}>
        <span style={{ font: "600 10px 'IBM Plex Mono', ui-monospace, Menlo, monospace", color: usage ? 'var(--proto-ink)' : 'var(--proto-muted)' }}>
          {vm.compact}
        </span>
        <span style={{ fontSize: 10, color: 'var(--proto-muted)' }}>
          {usage ? vm.percentLabel : copy.unavailable}
        </span>
      </span>
    </button>
  );

  return (
    <div style={wrapperStyle}>
      <Modal title={copy.title} trigger={trigger}>
        <ContextUsageDetails usage={usage} lang={lang} />
      </Modal>
    </div>
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
