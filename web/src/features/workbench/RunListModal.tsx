// input:  ScheduleRow, schedule-rail ordinals, i18n vocab
// output: 30b run-list modal (RUN · FIRED · COST)
// pos:    Repeating schedule's run history → open a run in chat
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useEffect } from 'react';
import { useVocab } from '@/i18n';
import { runOrdinals, type ScheduleRow } from './schedule-rail';
import { cadenceLabel, nextRunDelta } from './scheduled-chat';
import { sessionStamp } from './session-groups';
import { formatCost } from './right-panel-vm';

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
  onClose,
}: {
  row: ScheduleRow;
  selectedSessionId: string | null;
  onOpenRun: (sessionId: string) => void;
  onManage?: () => void;
  onClose: () => void;
}): JSX.Element {
  const L = useVocab();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const now = Date.now();
  const ordinals = runOrdinals(row.runs);
  const sched = row.schedule;
  const delta = sched ? nextRunDelta(sched.nextRun, now) : null;
  const sub = sched
    ? cadenceLabel(sched) +
      (sched.paused ? ` · ${L.wbSchedPausedPill}` : delta ? ` · ${L.wbSchedNextRun.replace('{d}', delta)}` : '')
    : null;

  return (
    <>
      <div
        data-backdrop="run-list"
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(25,28,34,.34)', zIndex: 60, animation: 'cxfade .18s ease' }}
      />
      <div
        data-modal="run-list"
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%,-50%)',
          width: 400,
          maxWidth: 'calc(100vw - 40px)',
          background: 'var(--proto-card)',
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(10,14,24,.35)',
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
            {sub && <div style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)', marginTop: 2 }}>{sub}</div>}
          </div>
          {sched && onManage && (
            <span
              data-action="run-list-manage"
              onClick={onManage}
              style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, color: 'var(--proto-accent)', flex: 'none', cursor: 'pointer' }}
            >
              {L.wbSchedManage}
            </span>
          )}
          <span
            data-action="run-list-close"
            onClick={onClose}
            style={{ marginLeft: sched && onManage ? 0 : 'auto', fontSize: 12, color: 'var(--proto-muted-3)', flex: 'none', cursor: 'pointer', padding: '0 2px' }}
          >
            ✕
          </span>
        </div>
        {/* Column captions are design constants (mono uppercase in both languages), not copy. */}
        <div style={{ ...GRID, padding: '8px 18px 6px', font: `600 9.5px ${mono}`, color: 'var(--proto-muted-3)', letterSpacing: '.05em', flex: 'none' }}>
          <span>RUN</span>
          <span>FIRED</span>
          <span style={{ textAlign: 'right' }}>COST</span>
        </div>
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {row.runs.map((r, i) => {
            const active = r.sessionId === selectedSessionId;
            return (
              <div
                key={r.sessionId}
                data-run-row={r.sessionId}
                onClick={() => onOpenRun(r.sessionId)}
                style={{
                  ...GRID,
                  cursor: 'pointer',
                  background: active ? 'var(--proto-accent-bg)' : 'transparent',
                  borderTop: i === 0 ? 'none' : '1px solid var(--proto-gray)',
                }}
              >
                <span style={{ font: `${r.unread ? 600 : 400} 11px ${mono}`, color: r.unread ? 'var(--proto-ink)' : 'var(--proto-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  #{ordinals.get(r.sessionId)}
                  {r.unread && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-accent)' }} />}
                </span>
                <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted-2)' }}>{sessionStamp(r, now)}</span>
                <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted-3)', textAlign: 'right' }}>
                  {r.costUsd != null ? formatCost(r.costUsd) : '—'}
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', padding: '10px 18px 13px', borderTop: '1px solid var(--proto-line)', flex: 'none' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-muted-2)' }}>
            {L.wbAllRuns.replace('{n}', String(row.runs.length))}
          </span>
          <span style={{ marginLeft: 'auto', font: `400 9.5px ${mono}`, color: 'var(--proto-muted-3)' }}>{L.wbSchedRunListHint}</span>
        </div>
      </div>
    </>
  );
}
