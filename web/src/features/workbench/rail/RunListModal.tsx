// input:  Modal, schedule rows, run labels, vocabulary
// output: RunListModal
// pos:    Scheduled session history and run navigation dialog
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { Modal } from '@/design/Modal';
import { useVocab } from '@/i18n';
import { runOrdinals, unreadRunIds, type ScheduleRow } from '@/features/session/list/schedule-rail';
import { cadenceLabel, nextRunDelta } from '@/features/session/list/scheduled-chat';
import { sessionStamp } from '@/features/session/list/session-groups';
import { formatUsd } from '@/lib/format';

const mono = "'IBM Plex Mono',monospace";

// Design 30b: the ONLY run drill-in for a repeating schedule — three columns, no status prose.
// Clicking a run hands its sessionId back (the workbench opens it in the chat pane and closes
// the modal). `manage ↗` opens the schedule edit overlay when the record is still live.

const GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '64px 1fr 76px',
  gap: 10,
  padding: '9px 18px',
  alignItems: 'center',
};

export function RunListModal({
  row,
  selectedSessionId,
  onOpenRun,
  onManage,
  onMarkAllRead,
  markAllPending = false,
  onClose,
}: {
  row: ScheduleRow;
  selectedSessionId: string | null;
  onOpenRun: (sessionId: string) => void;
  onManage?: () => void;
  /** Clears the unread dots for the runs listed here, without opening any of them. */
  onMarkAllRead?: (sessionIds: string[]) => void;
  markAllPending?: boolean;
  onClose: () => void;
}): JSX.Element {
  const L = useVocab();
  const now = Date.now();
  const ordinals = runOrdinals(row.runs);
  const unreadIds = unreadRunIds(row);
  const sched = row.schedule;
  const delta = sched ? nextRunDelta(sched.nextRun, now) : null;
  const sub = sched
    ? cadenceLabel(sched) +
      (sched.paused ? ` · ${L.wbSchedPausedPill}` : delta ? ` · ${L.wbSchedNextRun.replace('{d}', delta)}` : '')
    : null;

  return (
    <Modal
      chrome="bare"
      size="custom"
      open={true}
      showClose={false}
      title={row.title}
      description={sub ?? L.wbSchedRunListHint}
      onOpenChange={(open) => { if (!open) onClose(); }}
      contentDataAttributes={{ 'data-modal': 'run-list' }}
      overlayDataAttributes={{ 'data-backdrop': 'run-list' }}
      bodyStyle={{ display: 'contents' }}
      contentStyle={{
        position: 'fixed',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%,-50%)',
        width: 400,
        maxWidth: 'calc(100vw - 40px)',
        background: 'var(--material-overlay-bg)',
        backdropFilter: 'var(--glass-filter)',
        WebkitBackdropFilter: 'var(--glass-filter)',
        borderRadius: 'var(--r-float)',
        boxShadow: 'var(--material-overlay-shadow)',
        overflow: 'hidden',
        zIndex: 61,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'min(560px, calc(100vh - 80px))',
      }}
    >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '15px 18px 12px', borderBottom: '1px solid var(--proto-line)', flex: 'none' }}>
          <svg width={13} height={13} viewBox="0 0 14 14" fill="none" stroke="var(--proto-accent)" strokeWidth={1.6} style={{ flex: 'none' }}>
            <circle cx="7" cy="7" r="5.6" />
            <path d="M7 4v3.2l2.2 1.3" />
          </svg>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--proto-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {row.title}
            </div>
            {sub && <div style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' , marginTop: 2 }}>{sub}</div>}
          </div>
          {sched && onManage && (
            <button
              type="button"
              className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent"
              data-action="run-list-manage"
              onClick={onManage}
              style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--proto-accent)', flex: 'none', cursor: 'pointer' }}
            >
              {L.wbSchedManage}
            </button>
          )}
          <button
            type="button"
            aria-label="Close"
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent"
            data-action="run-list-close"
            onClick={onClose}
            style={{ marginLeft: sched && onManage ? 0 : 'auto', fontSize: 12, color: 'var(--proto-muted)', flex: 'none', cursor: 'pointer', padding: '5px 8px', borderRadius: 'var(--r-chip)'  }}
          >
            ✕
          </button>
        </div>
        {/* Column captions are design constants (mono uppercase in both languages), not copy. */}
        <div style={{ ...GRID, background: 'transparent', padding: '8px 18px 6px', font: `600 11px ${mono}`, color: 'var(--proto-muted)' , letterSpacing: '.05em', flex: 'none' }}>
          <span>RUN</span>
          <span>FIRED</span>
          <span style={{ textAlign: 'right' }}>COST</span>
        </div>
        <div style={{ background: 'transparent', overflowY: 'auto', minHeight: 0 }}>
          {row.runs.map((r, i) => {
            const active = r.sessionId === selectedSessionId;
            return (
              <button
                type="button"
                aria-pressed={active}
                className="focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-proto-accent"
                key={r.sessionId}
                data-run-row={r.sessionId}
                onClick={() => onOpenRun(r.sessionId)}
                style={{
                  ...GRID,
                  width: '100%',
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: active ? 'var(--proto-accent-bg)' : 'transparent',
                  borderTop: i === 0 ? 'none' : '1px solid var(--proto-gray)',
                }}
              >
                <span style={{ font: `${r.unread ? 600 : 400} 11px ${mono}`, color: r.unread ? 'var(--proto-ink)' : 'var(--proto-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  #{ordinals.get(r.sessionId)}
                  {r.unread && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-accent)' }} />}
                </span>
                <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>{sessionStamp(r, now)}</span>
                <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)', textAlign: 'right' }}>
                  {r.costUsd != null ? formatUsd(r.costUsd) : '—'}
                </span>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', background: 'transparent', padding: '10px 18px 13px', borderTop: '1px solid var(--proto-line)', flex: 'none' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-muted)'  }}>
            {L.wbAllRuns.replace('{n}', String(row.runs.length))}
          </span>
          {onMarkAllRead && unreadIds.length > 0 ? (
            <button
              type="button"
              disabled={markAllPending}
              className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent"
              data-action="run-list-mark-read"
              onClick={() => { if (!markAllPending) onMarkAllRead(unreadIds); }}
              style={{
                marginLeft: 'auto',
                fontSize: 11,
                fontWeight: 600,
                color: markAllPending ? 'var(--proto-muted)' : 'var(--proto-accent)',
                cursor: markAllPending ? 'not-allowed' : 'pointer',
              }}
            >
              {L.wbSchedMarkAllRead.replace('{n}', String(unreadIds.length))}
            </button>
          ) : (
            <span style={{ marginLeft: 'auto', font: `400 11px ${mono}`, color: 'var(--proto-muted)'  }}>{L.wbSchedRunListHint}</span>
          )}
        </div>
    </Modal>
  );
}
