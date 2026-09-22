import type { ReactNode } from 'react';
import { severityTone, type DegradedSeverity } from './degraded';

// Degraded / exception state card (design §5, design 10c). Unified color language:
// amber(waiting) / red(human) / blue(info). No hard-coded hex — the tinted header and
// dot come from the `pill-<tone>-{bg,fg}` and `state-{run|wait|fail}` tokens, selected
// via `severityTone` (the tested invariant lives in ./degraded.ts).

const HEADER_CLASS: Record<DegradedSeverity, string> = {
  waiting: 'bg-pill-waiting-bg text-pill-waiting-fg',
  human: 'bg-pill-failed-bg text-pill-failed-fg',
  info: 'bg-pill-running-bg text-pill-running-fg',
};

const DOT_CLASS: Record<DegradedSeverity, string> = {
  waiting: 'bg-state-wait',
  human: 'bg-state-fail',
  info: 'bg-state-run',
};

export interface DegradedStateProps {
  severity: DegradedSeverity;
  title: ReactNode;
  /** Right-aligned mono meta in the header (e.g. `resets 14:00 · 2h 08m`). */
  meta?: ReactNode;
  /** Body detail line(s). */
  detail?: ReactNode;
  /** Body action row (buttons / links). */
  actions?: ReactNode;
  /** Extra structured body content (lists, step notes). */
  children?: ReactNode;
  /** Pulse the status dot (waiting/live states). */
  pulse?: boolean;
  className?: string;
}

export function DegradedState({
  severity,
  title,
  meta,
  detail,
  actions,
  children,
  pulse,
  className,
}: DegradedStateProps) {
  // severityTone() drives the semantic; the class maps mirror StatusPill's token pairing.
  void severityTone(severity);
  const hasBody = detail || actions || children;
  return (
    <div
      className={['overflow-hidden rounded-[var(--r-card)] border border-card bg-surface-card shadow-card', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={['flex items-center gap-1g px-1.5g py-1g', HEADER_CLASS[severity]].join(' ')}>
        <span
          className={[
            'h-1g w-1g flex-none rounded-full',
            DOT_CLASS[severity],
            pulse ? 'animate-pulse' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        />
        <span className="text-ui font-medium">{title}</span>
        {meta && <span className="ml-auto font-mono text-ui opacity-80">{meta}</span>}
      </div>
      {hasBody && (
        <div className="flex flex-col gap-1g p-1.5g">
          {detail && <div className="text-ui text-state-ink/80">{detail}</div>}
          {children}
          {actions && <div className="flex flex-wrap gap-1g">{actions}</div>}
        </div>
      )}
    </div>
  );
}
