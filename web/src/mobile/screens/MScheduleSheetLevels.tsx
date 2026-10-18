import { fmt, useLang, type Vocab } from '@/i18n';
import { MBackChevron, MC, M_NUM } from '@/mobile/ui/kit';
import type { TimeLang } from '@/i18n/time-format';
import { runOrdinals, scheduleSubline, unreadRunIds, type ScheduleRow } from '@/features/session/list/schedule-rail';
import { cadenceLabel, nextRunDelta } from '@/features/session/list/scheduled-chat';
import { sessionStamp } from '@/features/session/list/session-groups';
import { formatUsd } from '@/lib/format';

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

function PendingSubline({ sub, copy }: { sub: SublineValue; copy: Vocab }) {
  if (sub.kind !== 'pending') return null;
  return <>{sub.cadence}{sub.nextDelta && <> · {fmt(copy.schedNextIn, { d: sub.nextDelta })}</>}</>;
}

function PausedSubline({ sub, copy }: { sub: SublineValue; copy: Vocab }) {
  if (sub.kind !== 'paused') return null;
  return <>{sub.cadence} · <span style={{ color: MC.amberText }}>{copy.wbSchedPausedPill}</span></>;
}

function Subline({ row, copy, now }: { row: ScheduleRow; copy: Vocab; now: number }) {
  const lang = useLang();
  const sub = scheduleSubline(row, now, lang);
  return (
    <div style={{ fontSize: 12.5, color: MC.muted, marginTop: 2, ...M_NUM }}>
      <RunSubline sub={sub} />
      <PendingSubline sub={sub} copy={copy} />
      <PausedSubline sub={sub} copy={copy} />
    </div>
  );
}

function ListHeader({ rows, copy }: { rows: ScheduleRow[]; copy: Vocab }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px 10px' }}>
      <ClockIcon size={14} color={MC.muted} />
      <span style={{ fontSize: 17, fontWeight: 650, color: MC.ink }}>
        {copy.schedSheetTitle}
      </span>
      <span style={{ fontSize: 13, color: MC.muted, ...M_NUM }}>
        {fmt(copy.schedSheetCount, { n: rows.length })}
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

function ScheduleRowMeta({ row, copy }: { row: ScheduleRow; copy: Vocab }) {
  return <>
    <span style={{ fontSize: 12.5, color: MC.muted, flex: 'none', ...M_NUM }}>
      {row.kind === 'repeat' ? `×${row.runs.length}` : copy.scTypeOnce}
    </span>
    {row.unread && <span style={{ width: 7, height: 7, borderRadius: '50%', background: MC.run, flex: 'none' }} />}
    <span style={{ fontSize: 13, color: MC.muted, flex: 'none' }}>›</span>
  </>;
}

function ScheduleRowView({ row, copy, now, last, onRow }: {
  row: ScheduleRow; copy: Vocab; now: number; last: boolean;
  onRow: (row: ScheduleRow) => void;
}) {
  return (
    <div data-schedule-row={row.scheduleId} onClick={() => onRow(row)} style={scheduleRowStyle(last)}>
      <ClockIcon size={13} color={MC.muted} />
      <ScheduleRowText row={row} copy={copy} now={now} />
      <ScheduleRowMeta row={row} copy={copy} />
    </div>
  );
}

function ScheduleRowText({ row, copy, now }: {
  row: ScheduleRow; copy: Vocab; now: number;
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
  rows: ScheduleRow[]; copy: Vocab; now: number;
  onRow: (row: ScheduleRow) => void;
}) {
  return (
    <div style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
      {rows.map((row, index) => <ScheduleRowView key={row.scheduleId} row={row} copy={copy}
        now={now} last={index === rows.length - 1} onRow={onRow} />)}
    </div>
  );
}

export function ListLevel({ rows, copy, now, onRow }: {
  rows: ScheduleRow[]; copy: Vocab; now: number;
  onRow: (row: ScheduleRow) => void;
}) {
  return <><ListHeader rows={rows} copy={copy} />
    <ScheduleRows rows={rows} copy={copy} now={now} onRow={onRow} /></>;
}

function runsSubline(row: ScheduleRow, copy: Vocab, now: number, lang: TimeLang): string | null {
  const schedule = row.schedule;
  if (!schedule) return null;
  const delta = nextRunDelta(schedule.nextRun, now, lang);
  const suffix = schedule.paused
    ? ` · ${copy.wbSchedPausedPill}`
    : delta ? ` · ${fmt(copy.schedNextIn, { d: delta })}` : '';
  return cadenceLabel(schedule, lang) + suffix;
}

function RunsHeader({ row, copy, now, onBack }: {
  row: ScheduleRow; copy: Vocab; now: number; onBack: () => void;
}) {
  const lang = useLang();
  const subline = runsSubline(row, copy, now, lang);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px 10px' }}>
      <span data-action="sheet-back" role="button" aria-label={copy.back} onClick={onBack}
        style={{ color: MC.ink, flex: 'none', cursor: 'pointer', minWidth: 44, minHeight: 44, margin: '0 -8px 0 -10px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <MBackChevron />
      </span>
      <ClockIcon size={14} color={MC.muted} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 650, color: MC.ink,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.title}</div>
        {subline && <div style={{ fontSize: 12.5, color: MC.muted, marginTop: 1, ...M_NUM }}>{subline}</div>}
      </div>
    </div>
  );
}

function RunsCaptions({ copy }: { copy: Vocab }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 70px', gap: 10,
      padding: '4px 15px 6px', fontSize: 12, fontWeight: 600, color: MC.muted }}>
      <span>{copy.schedColRun}</span><span>{copy.schedColFired}</span><span style={{ textAlign: 'right' }}>{copy.schedColCost}</span>
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
  return <span style={{ fontSize: 13, fontWeight: run.unread ? 600 : 400, ...M_NUM,
    color: run.unread ? MC.ink : 'var(--proto-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
    #{ordinal}
    {run.unread && <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.run }} />}
  </span>;
}

function RunCost({ cost }: { cost: number | null }) {
  return <span style={{ fontSize: 13, color: MC.muted, textAlign: 'right', ...M_NUM }}>
    {cost != null ? formatUsd(cost) : '—'}
  </span>;
}

function RunRow({ run, ordinal, first, now, onOpenRun }: {
  run: ScheduleRow['runs'][number]; ordinal: number | undefined; first: boolean; now: number;
  onOpenRun: (sessionId: string) => void;
}) {
  return (
    <div data-run-row={run.sessionId} onClick={() => onOpenRun(run.sessionId)} style={runRowStyle(first)}>
      <RunOrdinal run={run} ordinal={ordinal} />
      <span style={{ fontSize: 13, color: 'var(--proto-muted-2)', ...M_NUM }}>{sessionStamp(run, now)}</span>
      <RunCost cost={run.costUsd} />
    </div>
  );
}

function RunsList({ row, now, onOpenRun }: {
  row: ScheduleRow; now: number; onOpenRun: (sessionId: string) => void;
}) {
  const ordinals = runOrdinals(row.runs);
  return (
    <div style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)',
      overflow: 'hidden', maxHeight: '46vh', overflowY: 'auto' }}>
      {row.runs.map((run, index) => <RunRow key={run.sessionId} run={run}
        ordinal={ordinals.get(run.sessionId)} first={index === 0} now={now} onOpenRun={onOpenRun} />)}
    </div>
  );
}

/** Takes the hint's slot while this schedule still has unread runs — clearing them beats
 *  re-reading a static hint. */
function MarkAllReadAction({ unreadIds, copy, pending, onMarkAllRead }: {
  unreadIds: string[]; copy: Vocab; pending: boolean;
  onMarkAllRead: (sessionIds: string[]) => void;
}) {
  return (
    <button type="button" data-action="mark-all-read" disabled={pending}
      onClick={() => onMarkAllRead(unreadIds)}
      style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: MC.run,
        fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, cursor: pending ? 'default' : 'pointer',
        opacity: pending ? 0.5 : 1, padding: 0 }}>
      {fmt(copy.schedMarkRead, { n: unreadIds.length })}
    </button>
  );
}

function RunsFooter({ row, copy, onEdit, onMarkAllRead, markAllPending = false }: {
  row: ScheduleRow; copy: Vocab; onEdit?: () => void;
  onMarkAllRead?: (sessionIds: string[]) => void; markAllPending?: boolean;
}) {
  const unreadIds = unreadRunIds(row);
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', padding: '10px 4px 0', gap: 10 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: MC.muted, ...M_NUM }}>
        {fmt(copy.schedAllRuns, { n: row.runs.length })}
      </span>
      {onEdit && <button type="button" data-action="edit-schedule" onClick={onEdit}
        style={{ border: 0, background: 'transparent', color: MC.run, fontFamily: 'var(--font-ui)', fontSize: 13,
          fontWeight: 600, cursor: 'pointer' }}>{copy.scEditSchedule}</button>}
      {onMarkAllRead && unreadIds.length > 0 ? (
        <MarkAllReadAction unreadIds={unreadIds} copy={copy} pending={markAllPending}
          onMarkAllRead={onMarkAllRead} />
      ) : null}
    </div>
  );
}

export function RunsLevel({ row, copy, now, onBack, onOpenRun, onEdit, onMarkAllRead,
  markAllPending }: {
  row: ScheduleRow; copy: Vocab; now: number; onBack: () => void;
  onOpenRun: (sessionId: string) => void; onEdit?: () => void;
  onMarkAllRead?: (sessionIds: string[]) => void; markAllPending?: boolean;
}) {
  return (
    <>
      <RunsHeader row={row} copy={copy} now={now} onBack={onBack} />
      {/* Column captions follow the UI language, in sentence case like every other label. */}
      <RunsCaptions copy={copy} />
      <RunsList row={row} now={now} onOpenRun={onOpenRun} />
      <RunsFooter row={row} copy={copy} onEdit={onEdit} onMarkAllRead={onMarkAllRead}
        markAllPending={markAllPending} />
    </>
  );
}
