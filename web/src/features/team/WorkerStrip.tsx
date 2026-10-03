import { useState, type CSSProperties } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useVocabOptional } from '@/i18n';
import { isRetiredWorker } from './worker-groups';

// A lead session's workers as one compact row of chips under the chat header — the lead's view of
// its team, outside the transcript scroll like the commission banner. Each chip opens that worker.
// Retired workers are not on the strip (the rail still lists them), so a team that has wound down
// leaves nothing behind here.

/** The rail's dot language: amber = blocked on you, accent = running, hollow ring = waiting on a
 *  machine, faint = idle. */
export function workerDotStyle(s: SessionInfo): CSSProperties {
  const base: CSSProperties = { width: 6, height: 6, borderRadius: '50%', boxSizing: 'border-box', flex: 'none' };
  if (s.awaitingInput) return { ...base, background: 'var(--proto-amber)' };
  if (s.running) return { ...base, background: 'var(--proto-accent)' };
  if ((s.waitingOn ?? 0) > 0) return { ...base, border: '1.5px solid var(--proto-muted-3)' };
  return { ...base, background: 'var(--proto-line-3)' };
}

export function workerTitle(s: SessionInfo): string {
  return s.workerName || s.label || s.name || s.sessionId;
}

function WorkerChip({ worker, touch, onOpen }: {
  worker: SessionInfo;
  touch: boolean;
  onOpen: (sessionId: string) => void;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  const title = workerTitle(worker);
  return (
    <button
      type="button"
      data-worker-chip={worker.sessionId}
      title={worker.label && worker.label !== title ? `${title} · ${worker.label}` : title}
      onClick={() => onOpen(worker.sessionId)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flex: 'none',
        maxWidth: 180,
        height: touch ? 28 : 22,
        padding: '0 8px',
        border: 0,
        borderRadius: 'var(--r-chip)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: touch ? 12.5 : 12,
        fontWeight: worker.unread ? 600 : 400,
        color: worker.unread ? 'var(--proto-ink)' : 'var(--proto-ink-2)',
        background: hover ? 'var(--proto-gray)' : 'var(--proto-line-2)',
      }}
    >
      <span aria-hidden="true" style={workerDotStyle(worker)} />
      <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
    </button>
  );
}

export function WorkerStrip({ workers, onOpen, touch = false, style }: {
  /** The lead's workers; retired ones are dropped here. */
  workers: SessionInfo[];
  onOpen: (sessionId: string) => void;
  /** Mobile: taller chips, horizontal scroll instead of wrapping. */
  touch?: boolean;
  style?: CSSProperties;
}): JSX.Element | null {
  const L = useVocabOptional();
  const active = workers.filter((w) => !isRetiredWorker(w));
  if (active.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={L.wbTeamWorkers}
      data-worker-strip=""
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        ...(touch
          ? { overflowX: 'auto', scrollbarWidth: 'none' }
          : { flexWrap: 'wrap', margin: '8px 24px 0' }),
        ...style,
      }}
    >
      {active.map((w) => <WorkerChip key={w.sessionId} worker={w} touch={touch} onOpen={onOpen} />)}
    </div>
  );
}
