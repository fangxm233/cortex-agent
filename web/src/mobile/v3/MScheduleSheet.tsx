// input:  ScheduleRow slots from schedule-rail, MBottomSheet kit
// output: 8b schedule list ↔ 8c run list bottom sheet
// pos:    Mobile Scheduled drill-in sheet (opens runs as sessions)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useState } from 'react';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import {
  runOrdinals,
  scheduleRowAction,
  scheduleSubline,
  type ScheduleRow,
} from '@/features/workbench/schedule-rail';
import { cadenceLabel, nextRunDelta } from '@/features/workbench/scheduled-chat';
import { sessionStamp } from '@/features/workbench/session-groups';
import { formatCost } from '@/features/workbench/right-panel-vm';

// Design 8b/8c (scheme-mobile §8): one sheet, two levels. The list level shows every schedule of
// the current project (repeat ×N / 单次, unread dot); tapping a repeating row pushes the run list
// IN the sheet (‹ returns), tapping a once row (or any run) hands the sessionId to the screen,
// which closes the sheet and drills into the ordinary session page (8d).

export interface MScheduleSheetCopy {
  title: string;
  countUnit: string;
  once: string;
  paused: string;
  nextIn: string;
  allRuns: string;
  runListHint: string;
}

function ClockIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.6} style={{ flex: 'none' }}>
      <circle cx="7" cy="7" r="5.6" />
      <path d="M7 4v3.2l2.2 1.3" />
    </svg>
  );
}

function Subline({ row, copy, now }: { row: ScheduleRow; copy: MScheduleSheetCopy; now: number }) {
  const sub = scheduleSubline(row, now);
  return (
    <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 2 }}>
      {sub.kind === 'run' && (
        <>
          {sub.stamp}
          {sub.cost && <> · {sub.cost}</>}
        </>
      )}
      {sub.kind === 'pending' && (
        <>
          {sub.cadence}
          {sub.nextDelta && <> · {copy.nextIn.replace('{d}', sub.nextDelta)}</>}
        </>
      )}
      {sub.kind === 'paused' && (
        <>
          {sub.cadence} · <span style={{ color: MC.amberText }}>{copy.paused}</span>
        </>
      )}
    </div>
  );
}

function ListLevel({
  rows,
  copy,
  now,
  onRow,
}: {
  rows: ScheduleRow[];
  copy: MScheduleSheetCopy;
  now: number;
  onRow: (row: ScheduleRow) => void;
}) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px 10px' }}>
        <ClockIcon size={14} color={MC.run} />
        <span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>{copy.title}</span>
        <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>
          {copy.countUnit.replace('{n}', String(rows.length))}
        </span>
      </div>
      <div style={{ background: MC.card, border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden' }}>
        {rows.map((row, i) => (
          <div
            key={row.scheduleId}
            data-schedule-row={row.scheduleId}
            onClick={() => onRow(row)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: 13,
              minHeight: 44,
              boxSizing: 'border-box',
              cursor: 'pointer',
              borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${MC.divider}`,
            }}
          >
            <ClockIcon size={13} color={row.unread ? MC.run : MC.faint} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: row.unread ? 600 : 400,
                  color: row.unread ? MC.ink : 'var(--proto-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {row.title}
              </div>
              <Subline row={row} copy={copy} now={now} />
            </div>
            <span style={{ font: `500 10px ${MONO}`, color: MC.muted, flex: 'none' }}>
              {row.kind === 'repeat' ? `×${row.runs.length}` : copy.once}
            </span>
            {row.unread && (
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: MC.run, flex: 'none' }} />
            )}
            <span style={{ fontSize: 13, color: MC.faint, flex: 'none' }}>›</span>
          </div>
        ))}
      </div>
    </>
  );
}

function RunsLevel({
  row,
  copy,
  now,
  onBack,
  onOpenRun,
}: {
  row: ScheduleRow;
  copy: MScheduleSheetCopy;
  now: number;
  onBack: () => void;
  onOpenRun: (sessionId: string) => void;
}) {
  const ordinals = runOrdinals(row.runs);
  const sched = row.schedule;
  const delta = sched ? nextRunDelta(sched.nextRun, now) : null;
  const sub = sched
    ? cadenceLabel(sched) + (sched.paused ? ` · ${copy.paused}` : delta ? ` · ${copy.nextIn.replace('{d}', delta)}` : '')
    : null;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px 10px' }}>
        <span
          data-action="sheet-back"
          onClick={onBack}
          style={{ fontSize: 15, color: MC.run, flex: 'none', cursor: 'pointer', padding: '0 2px' }}
        >
          ‹
        </span>
        <ClockIcon size={14} color={MC.run} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {row.title}
          </div>
          {sub && <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 1 }}>{sub}</div>}
        </div>
      </div>
      {/* Column captions are design constants (mono uppercase in both languages), not copy. */}
      <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 70px', gap: 10, padding: '4px 15px 6px', font: `600 9.5px ${MONO}`, color: MC.faint, letterSpacing: '.05em' }}>
        <span>RUN</span>
        <span>FIRED</span>
        <span style={{ textAlign: 'right' }}>COST</span>
      </div>
      <div style={{ background: MC.card, border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden', maxHeight: '46vh', overflowY: 'auto' }}>
        {row.runs.map((r, i) => (
          <div
            key={r.sessionId}
            data-run-row={r.sessionId}
            onClick={() => onOpenRun(r.sessionId)}
            style={{
              display: 'grid',
              gridTemplateColumns: '64px 1fr 70px',
              gap: 10,
              padding: 13,
              minHeight: 44,
              boxSizing: 'border-box',
              alignItems: 'center',
              cursor: 'pointer',
              borderTop: i === 0 ? 'none' : `1px solid ${MC.divider}`,
            }}
          >
            <span style={{ font: `${r.unread ? 600 : 400} 12px ${MONO}`, color: r.unread ? MC.ink : 'var(--proto-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              #{ordinals.get(r.sessionId)}
              {r.unread && <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.run }} />}
            </span>
            <span style={{ font: `400 12px ${MONO}`, color: 'var(--proto-muted-2)' }}>{sessionStamp(r, now)}</span>
            <span style={{ font: `400 12px ${MONO}`, color: MC.muted, textAlign: 'right' }}>
              {r.costUsd != null ? formatCost(r.costUsd) : '—'}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 4px 0' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: MC.muted }}>
          {copy.allRuns.replace('{n}', String(row.runs.length))}
        </span>
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint }}>{copy.runListHint}</span>
      </div>
    </>
  );
}

export function MScheduleSheet({
  rows,
  copy,
  onOpenSession,
  onEditPending,
  onClose,
}: {
  rows: ScheduleRow[];
  copy: MScheduleSheetCopy;
  onOpenSession: (sessionId: string) => void;
  /** A live schedule with no runs yet has nothing to drill into — the screen decides (no-op ok). */
  onEditPending?: (row: ScheduleRow) => void;
  onClose: () => void;
}) {
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const runsRow = runsFor ? rows.find((r) => r.scheduleId === runsFor) ?? null : null;
  const now = Date.now();

  const onRow = (row: ScheduleRow) => {
    const action = scheduleRowAction(row);
    if (action.type === 'modal') setRunsFor(row.scheduleId);
    else if (action.type === 'open') onOpenSession(action.sessionId);
    else onEditPending?.(row);
  };

  return (
    <MBottomSheet onClose={onClose}>
      {runsRow ? (
        <RunsLevel row={runsRow} copy={copy} now={now} onBack={() => setRunsFor(null)} onOpenRun={onOpenSession} />
      ) : (
        <ListLevel rows={rows} copy={copy} now={now} onRow={onRow} />
      )}
    </MBottomSheet>
  );
}
