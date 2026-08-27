// input:  schedule rows, localized sheet copy, timestamps, and level callbacks
// output: small DOM-preserving list and runs level presentations
// pos:    Presentational helpers for the mobile Scheduled sheet state machine
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { MC, MONO } from '@/mobile/ui/kit';
import { runOrdinals, scheduleSubline, type ScheduleRow } from '@/features/workbench/schedule-rail';
import { cadenceLabel, nextRunDelta } from '@/features/workbench/scheduled-chat';
import { sessionStamp } from '@/features/workbench/session-groups';
import { formatCost } from '@/features/workbench/right-panel-vm';

export interface MScheduleSheetCopy {
  title: string;
  countUnit: string;
  once: string;
  paused: string;
  nextIn: string;
  allRuns: string;
  runListHint: string;
  edit: string;
}

function ClockIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color}
      strokeWidth={1.6} style={{ flex: 'none' }}>
      <circle cx="7" cy="7" r="5.6" />
      <path d="M7 4v3.2l2.2 1.3" />
    </svg>
  );
}

type SublineValue = ReturnType<typeof scheduleSubline>;

function RunSubline({ sub }: { sub: SublineValue }) {
  if (sub.kind !== 'run') return null;
  return <>{sub.stamp}{sub.cost && <> · {sub.cost}</>}</>;
}

function PendingSubline({ sub, copy }: { sub: SublineValue; copy: MScheduleSheetCopy }) {
  if (sub.kind !== 'pending') return null;
  return <>{sub.cadence}{sub.nextDelta && <> · {copy.nextIn.replace('{d}', sub.nextDelta)}</>}</>;
}

function PausedSubline({ sub, copy }: { sub: SublineValue; copy: MScheduleSheetCopy }) {
  if (sub.kind !== 'paused') return null;
  return <>{sub.cadence} · <span style={{ color: MC.amberText }}>{copy.paused}</span></>;
}

function Subline({ row, copy, now }: { row: ScheduleRow; copy: MScheduleSheetCopy; now: number }) {
  const sub = scheduleSubline(row, now);
  return (
    <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 2 }}>
      <RunSubline sub={sub} />
      <PendingSubline sub={sub} copy={copy} />
      <PausedSubline sub={sub} copy={copy} />
    </div>
  );
}

function ListHeader({ rows, copy }: { rows: ScheduleRow[]; copy: MScheduleSheetCopy }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px 10px' }}>
      <ClockIcon size={14} color={MC.run} />
      <span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>
        {copy.title}
      </span>
      <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>
        {copy.countUnit.replace('{n}', String(rows.length))}
      </span>
    </div>
  );
}

function scheduleRowStyle(last: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 9, padding: 13, minHeight: 44,
    boxSizing: 'border-box', cursor: 'pointer',
    borderBottom: last ? 'none' : `1px solid ${MC.divider}`,
  };
}

function ScheduleRowMeta({ row, copy }: { row: ScheduleRow; copy: MScheduleSheetCopy }) {
  return <>
    <span style={{ font: `500 10px ${MONO}`, color: MC.muted, flex: 'none' }}>
      {row.kind === 'repeat' ? `×${row.runs.length}` : copy.once}
    </span>
    {row.unread && <span style={{ width: 7, height: 7, borderRadius: '50%', background: MC.run, flex: 'none' }} />}
    <span style={{ fontSize: 13, color: MC.faint, flex: 'none' }}>›</span>
  </>;
}

function ScheduleRowView({ row, copy, now, last, onRow }: {
  row: ScheduleRow; copy: MScheduleSheetCopy; now: number; last: boolean;
  onRow: (row: ScheduleRow) => void;
}) {
  return (
    <div data-schedule-row={row.scheduleId} onClick={() => onRow(row)} style={scheduleRowStyle(last)}>
      <ClockIcon size={13} color={row.unread ? MC.run : MC.faint} />
      <ScheduleRowText row={row} copy={copy} now={now} />
      <ScheduleRowMeta row={row} copy={copy} />
    </div>
  );
}

function ScheduleRowText({ row, copy, now }: {
  row: ScheduleRow; copy: MScheduleSheetCopy; now: number;
}) {
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 14, fontWeight: row.unread ? 600 : 400,
        color: row.unread ? MC.ink : 'var(--proto-muted)', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {row.title}
      </div>
      <Subline row={row} copy={copy} now={now} />
    </div>
  );
}

function ScheduleRows({ rows, copy, now, onRow }: {
  rows: ScheduleRow[]; copy: MScheduleSheetCopy; now: number;
  onRow: (row: ScheduleRow) => void;
}) {
  return (
    <div style={{ background: MC.card, border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden' }}>
      {rows.map((row, index) => <ScheduleRowView key={row.scheduleId} row={row} copy={copy}
        now={now} last={index === rows.length - 1} onRow={onRow} />)}
    </div>
  );
}

export function ListLevel({ rows, copy, now, onRow }: {
  rows: ScheduleRow[]; copy: MScheduleSheetCopy; now: number;
  onRow: (row: ScheduleRow) => void;
}) {
  return <><ListHeader rows={rows} copy={copy} />
    <ScheduleRows rows={rows} copy={copy} now={now} onRow={onRow} /></>;
}

function runsSubline(row: ScheduleRow, copy: MScheduleSheetCopy, now: number): string | null {
  const schedule = row.schedule;
  if (!schedule) return null;
  const delta = nextRunDelta(schedule.nextRun, now);
  const suffix = schedule.paused
    ? ` · ${copy.paused}`
    : delta ? ` · ${copy.nextIn.replace('{d}', delta)}` : '';
  return cadenceLabel(schedule) + suffix;
}

function RunsHeader({ row, copy, now, onBack }: {
  row: ScheduleRow; copy: MScheduleSheetCopy; now: number; onBack: () => void;
}) {
  const subline = runsSubline(row, copy, now);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px 10px' }}>
      <span data-action="sheet-back" onClick={onBack}
        style={{ fontSize: 15, color: MC.run, flex: 'none', cursor: 'pointer', padding: '0 2px' }}>‹</span>
      <ClockIcon size={14} color={MC.run} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.title}</div>
        {subline && <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 1 }}>{subline}</div>}
      </div>
    </div>
  );
}

function RunsCaptions() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 70px', gap: 10,
      padding: '4px 15px 6px', font: `600 9.5px ${MONO}`, color: MC.faint, letterSpacing: '.05em' }}>
      <span>RUN</span><span>FIRED</span><span style={{ textAlign: 'right' }}>COST</span>
    </div>
  );
}

function runRowStyle(first: boolean): React.CSSProperties {
  return {
    display: 'grid', gridTemplateColumns: '64px 1fr 70px', gap: 10, padding: 13,
    minHeight: 44, boxSizing: 'border-box', alignItems: 'center', cursor: 'pointer',
    borderTop: first ? 'none' : `1px solid ${MC.divider}`,
  };
}

function RunOrdinal({ run, ordinal }: {
  run: ScheduleRow['runs'][number]; ordinal: number | undefined;
}) {
  return <span style={{ font: `${run.unread ? 600 : 400} 12px ${MONO}`,
    color: run.unread ? MC.ink : 'var(--proto-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
    #{ordinal}
    {run.unread && <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.run }} />}
  </span>;
}

function RunCost({ cost }: { cost: number | null }) {
  return <span style={{ font: `400 12px ${MONO}`, color: MC.muted, textAlign: 'right' }}>
    {cost != null ? formatCost(cost) : '—'}
  </span>;
}

function RunRow({ run, ordinal, first, now, onOpenRun }: {
  run: ScheduleRow['runs'][number]; ordinal: number | undefined; first: boolean; now: number;
  onOpenRun: (sessionId: string) => void;
}) {
  return (
    <div data-run-row={run.sessionId} onClick={() => onOpenRun(run.sessionId)} style={runRowStyle(first)}>
      <RunOrdinal run={run} ordinal={ordinal} />
      <span style={{ font: `400 12px ${MONO}`, color: 'var(--proto-muted-2)' }}>{sessionStamp(run, now)}</span>
      <RunCost cost={run.costUsd} />
    </div>
  );
}

function RunsList({ row, now, onOpenRun }: {
  row: ScheduleRow; now: number; onOpenRun: (sessionId: string) => void;
}) {
  const ordinals = runOrdinals(row.runs);
  return (
    <div style={{ background: MC.card, border: `1px solid ${MC.hairline}`, borderRadius: 13,
      overflow: 'hidden', maxHeight: '46vh', overflowY: 'auto' }}>
      {row.runs.map((run, index) => <RunRow key={run.sessionId} run={run}
        ordinal={ordinals.get(run.sessionId)} first={index === 0} now={now} onOpenRun={onOpenRun} />)}
    </div>
  );
}

function RunsFooter({ row, copy, onEdit }: {
  row: ScheduleRow; copy: MScheduleSheetCopy; onEdit?: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '10px 4px 0', gap: 10 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: MC.muted }}>
        {copy.allRuns.replace('{n}', String(row.runs.length))}
      </span>
      {onEdit && <button type="button" data-action="edit-schedule" onClick={onEdit}
        style={{ border: 0, background: 'transparent', color: MC.run, fontSize: 11.5,
          fontWeight: 600, cursor: 'pointer' }}>{copy.edit}</button>}
      <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint }}>
        {copy.runListHint}
      </span>
    </div>
  );
}

export function RunsLevel({ row, copy, now, onBack, onOpenRun, onEdit }: {
  row: ScheduleRow; copy: MScheduleSheetCopy; now: number; onBack: () => void;
  onOpenRun: (sessionId: string) => void; onEdit?: () => void;
}) {
  return (
    <>
      <RunsHeader row={row} copy={copy} now={now} onBack={onBack} />
      {/* Column captions are design constants (mono uppercase in both languages), not copy. */}
      <RunsCaptions />
      <RunsList row={row} now={now} onOpenRun={onOpenRun} />
      <RunsFooter row={row} copy={copy} onEdit={onEdit} />
    </>
  );
}
