import { useMemo, type CSSProperties, type KeyboardEvent } from 'react';
import '@/design/content-surfaces.css';
import './overview.css';
import { useNavigate } from 'react-router-dom';
import type { ExecutionInfo, IssueInfo, ScheduleInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { Button, IconButton } from '@/design';
import { confirmDialog } from '@/design/dialog-store';
import { useDockIntake } from '@/design/dock-intake';
import { fmt, useLang, useVocab } from '@/i18n';
import { formatSpanOrDash, relTime } from '@/i18n/time-format';
import { useNowTick } from '@/lib/useNowTick';
import { useExecutionDrawer } from '@/features/execution/useExecutionDrawer';
import { useScheduleModal } from '@/features/schedule/useScheduleModal';
import { cadenceLabel } from '@/features/session/list/scheduled-chat';
import { useIssues } from '@/features/issues/useIssues';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { DRAFT_SENTINEL } from '@/features/session/state/selected-session';
import { useSettings } from '@/features/settings/useSettings';
import { NotesButton } from '@/features/notes/NotesButton';
import { NotesOverviewCard } from '@/features/notes/NotesOverviewCard';
import { useNotes } from '@/features/notes/NotesProvider';
import { useOverviewData, type OverviewData } from './useOverviewData';
import { OverviewSpend } from './OverviewSpend';
import {
  ChevronLeftIcon,
  ClockIcon,
  DecisionIcon,
  ELLIPSIS,
  FileIcon,
  IconCell,
  IssueIcon,
  LINK,
  META,
  PlusIcon,
  RunMark,
  SectionHead,
  StatusDot,
} from './overview-parts';
import {
  clockOrDayLabel,
  execRows,
  lastRunLabel,
  needsYouReason,
  nextRunLabel,
  scheduleModelLabel,
  type OverviewSessionRow,
  type PendingDecisionsRow,
  type RecentMemoryFile,
} from './overview-vm';

// PROJECT OVERVIEW — one project's state on one page (design: canvas Overview). The work column
// (left) answers "what needs me, what is moving, what ran"; the right column holds spend,
// schedules, project memory and notes. Sections are small headings on the pane; the only card is
// Needs you, because it is the only thing on the page the user must act on.
//   - Needs you / In progress come from the rail's own session snapshot and dot language, so the
//     page and the rail never disagree; decisions count the project's boards' unanswered ones.
//   - Recent runs name each execution by its session's rail title; the execution id stays in the
//     row's tooltip.
//   - Adjust budget opens Settings ▸ Budget, where the global and per-project budgets live.

const INK: CSSProperties = { color: 'var(--proto-ink)', fontWeight: 550 };
const EMPTY: CSSProperties = { fontSize: 12.5, color: 'var(--proto-muted-3)' };
const ACTION_BUTTON: CSSProperties = { height: 28, padding: '0 11px', fontSize: 12.5, fontWeight: 500, flex: 'none' };

function activate(event: KeyboardEvent, run: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    run();
  }
}

function actionRowStyle(index: number): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minHeight: 52,
    boxSizing: 'border-box',
    padding: '8px 10px 8px 14px',
    fontSize: 13,
    borderTop: index > 0 ? '1px solid var(--proto-line-2)' : undefined,
  };
}

function TwoLines({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ ...ELLIPSIS, ...INK, display: 'block' }}>{title}</span>
      {sub && <span style={{ ...ELLIPSIS, display: 'block', marginTop: 2, fontSize: 12.5, color: 'var(--proto-muted)' }}>{sub}</span>}
    </span>
  );
}

function NeedsYouSection({ data, now, onReply, onViewBoard }: {
  data: OverviewData;
  now: number;
  onReply: (row: OverviewSessionRow) => void;
  onViewBoard: (row: PendingDecisionsRow) => void;
}): JSX.Element | null {
  const L = useVocab();
  const lang = useLang();
  const { needsYou, decisions, questions } = data;
  const count = needsYou.length + decisions.length;
  if (count === 0) return null;
  return (
    <section data-overview-needs-you="">
      <SectionHead title={L.ovNeedsYou} count={count} />
      <div className="ov-card">
        {needsYou.map((row, i) => (
          <div key={row.sessionId} data-needs-you-session={row.sessionId} style={actionRowStyle(i)}>
            <IconCell><StatusDot state="you" /></IconCell>
            <TwoLines title={row.title} sub={needsYouReason(questions[row.sessionId], row.at, now, lang)} />
            <Button variant="primary" aria-label={`${L.ovReply} · ${row.title}`} onClick={() => onReply(row)} style={ACTION_BUTTON}>
              {L.ovReply}
            </Button>
          </div>
        ))}
        {decisions.map((row, i) => (
          <div key={row.boardId} data-needs-you-board={row.boardId} style={actionRowStyle(needsYou.length + i)}>
            <IconCell><DecisionIcon /></IconCell>
            <TwoLines
              title={fmt(row.pending === 1 ? L.ovDecisionsPendingOne : L.ovDecisionsPendingMany, { n: row.pending })}
              sub={fmt(L.ovDecisionsWhere, { board: row.boardTitle, time: clockOrDayLabel(row.latestTs, now, lang) })}
            />
            <Button variant="secondary" aria-label={`${L.ovView} · ${row.boardTitle}`} onClick={() => onViewBoard(row)} style={ACTION_BUTTON}>
              {L.ovView}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function InProgressSection({ rows, now, onOpen }: {
  rows: OverviewSessionRow[];
  now: number;
  onOpen: (row: OverviewSessionRow) => void;
}): JSX.Element | null {
  const L = useVocab();
  const lang = useLang();
  if (rows.length === 0) return null;
  return (
    <section data-overview-in-progress="">
      <SectionHead title={L.ovInProgress} count={rows.length} />
      {rows.map((row) => {
        // The dot carries the state; its word goes to assistive tech with the row's name.
        const state = row.state === 'running' ? L.wbTeamStatusRunning : L.wbTeamStatusWaiting;
        return (
          <div
            key={row.sessionId}
            data-in-progress-session={row.sessionId}
            className="ov-row ov-row-link"
            role="button"
            tabIndex={0}
            aria-label={[row.title, state, row.doing].filter(Boolean).join(' · ')}
            onClick={() => onOpen(row)}
            onKeyDown={(event) => activate(event, () => onOpen(row))}
          >
            <IconCell><StatusDot state={row.state} /></IconCell>
            <span style={{ ...ELLIPSIS, ...INK, flex: 'none', maxWidth: '60%' }}>{row.title}</span>
            {row.doing && <span style={ELLIPSIS}>{row.doing}</span>}
            <span style={{ ...META, marginLeft: 'auto', flex: 'none', paddingLeft: 12 }}>{relTime(row.at, now, lang)}</span>
          </div>
        );
      })}
    </section>
  );
}

// Issues (design sec-24 24a): per-project ISSUES.md entries; rows open the issue center located at
// that entry. Hidden entirely at 0. The entry has no markdown field → only title + date.
function IssuesSection({ issues, onOpen }: { issues: IssueInfo[]; onOpen: (id?: string) => void }): JSX.Element | null {
  const L = useVocab();
  if (issues.length === 0) return null;
  return (
    <section data-issues-card="">
      <SectionHead
        title={L.issuesTitle}
        count={issues.length}
        action={<button type="button" className="content-text-action" onClick={() => onOpen()} style={LINK}>{L.isViewAll} ›</button>}
      />
      {issues.slice(0, 3).map((issue) => (
        <div
          key={issue.id}
          className="ov-row ov-row-link"
          role="button"
          tabIndex={0}
          onClick={() => onOpen(issue.id)}
          onKeyDown={(event) => activate(event, () => onOpen(issue.id))}
        >
          <IconCell><IssueIcon /></IconCell>
          <span style={{ ...ELLIPSIS, color: 'var(--proto-ink)' }}>{issue.title}</span>
          {issue.date && <span style={{ ...META, marginLeft: 'auto', flex: 'none', paddingLeft: 12 }}>{issue.date}</span>}
        </div>
      ))}
    </section>
  );
}

function RecentRunsSection({ executions, sessionsById, now, onLogs }: {
  executions: ExecutionInfo[];
  sessionsById: ReadonlyMap<string, SessionInfo>;
  now: number;
  onLogs: (executionId: string) => void;
}): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  const rows = useMemo(
    () => execRows(executions, sessionsById, now, lang, L),
    [executions, sessionsById, now, lang, L],
  );
  return (
    <section data-overview-runs="">
      <SectionHead title={L.ovRecentRuns} />
      {rows.length === 0 ? (
        <div style={EMPTY}>{L.ovNoExecutions}</div>
      ) : (
        <div role="table" aria-label={L.ovRecentRuns}>
          <div role="row" className="ov-run ov-run-head">
            <span role="columnheader" />
            <span role="columnheader">{L.ovColSession}</span>
            <span role="columnheader" className="ov-num ov-run-dur">{L.ovColDur}</span>
            <span role="columnheader" className="ov-num">{L.ovColCost}</span>
            <span role="columnheader" className="ov-num">{L.ovColTime}</span>
            <span role="columnheader" />
          </div>
          {rows.map((row) => (
            // The whole row opens the run's logs for the pointer; the Logs link is the keyboard way in.
            <div key={row.id} role="row" className="ov-run" data-execution-row={row.id}
              onClick={() => onLogs(row.id)} style={{ cursor: 'pointer' }}>
              <span role="cell"><RunMark mark={row.mark} label={row.statusWord} /></span>
              <span role="cell" title={`${row.title} · ${row.id}`} style={{ color: 'var(--proto-ink)', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                <span style={ELLIPSIS}>{row.title}</span>
                {row.tag && <span style={{ marginLeft: 8, flex: 'none', color: 'var(--proto-muted-3)' }}>{row.tag}</span>}
              </span>
              <span role="cell" className="ov-num ov-run-dur">{formatSpanOrDash(row.duration, lang)}</span>
              <span role="cell" className="ov-num">{row.cost}</span>
              <span role="cell" className="ov-num">{row.time}</span>
              <span role="cell" className="ov-num">
                <button
                  type="button"
                  className="content-text-action ov-reveal"
                  aria-label={`${L.ovLogs} · ${row.title}`}
                  onClick={(event) => { event.stopPropagation(); onLogs(row.id); }}
                  style={LINK}
                >
                  {L.ovLogs}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SchedulesSection({ schedules, now, onNew, onEdit, onDelete, onResume, deleting }: {
  schedules: ScheduleInfo[];
  now: number;
  onNew: () => void;
  onEdit: (s: ScheduleInfo) => void;
  onDelete: (s: ScheduleInfo) => void;
  onResume: (s: ScheduleInfo) => void;
  deleting: boolean;
}): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  const action: CSSProperties = { ...LINK, fontSize: 12 };
  return (
    <section data-overview-schedules="">
      <SectionHead
        title={L.scheduleCard}
        action={<button type="button" className="content-text-action" onClick={onNew} style={LINK}>+ {L.newSchedule}</button>}
      />
      {schedules.length === 0 && <div style={EMPTY}>{L.ovNoSchedules}</div>}
      {schedules.map((s) => {
        const model = scheduleModelLabel(s);
        const when = s.paused
          ? [L.paused, lastRunLabel(s.lastRun, now, lang, L)]
          : [nextRunLabel(s.nextRun, now, lang, L)];
        return (
          <div key={s.id} className="ov-row" style={{ alignItems: 'flex-start', padding: '6px 8px' }}>
            <IconCell top><ClockIcon /></IconCell>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span title={s.message} style={{ ...ELLIPSIS, ...INK, display: 'block', color: s.paused ? 'var(--proto-muted)' : 'var(--proto-ink)' }}>
                {s.message}
              </span>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 1, fontSize: 12.5, color: 'var(--proto-muted-3)' }}>
                <span style={{ ...ELLIPSIS, flex: '1 1 auto' }}>
                  {[cadenceLabel(s, lang), ...when].join(' · ')}
                  {model && <span title={L.scModel}>{' · '}{model}</span>}
                </span>
                <span style={{ display: 'inline-flex', gap: 10, flex: 'none' }}>
                  {/* A paused schedule's way back stays in view; edit and delete wait for the row. */}
                  {s.paused && (
                    <button type="button" className="content-text-action" data-schedule-resume={s.id} onClick={() => onResume(s)} style={action}>
                      {L.resume}
                    </button>
                  )}
                  <span className="ov-reveal-collapse">
                    <button type="button" className="content-text-action" data-schedule-edit={s.id} onClick={() => onEdit(s)} style={action}>
                      {L.scEditSchedule}
                    </button>
                    <button
                      type="button"
                      className="content-text-action"
                      data-schedule-delete={s.id}
                      onClick={() => onDelete(s)}
                      style={{ ...action, color: 'var(--proto-danger)', cursor: deleting ? 'not-allowed' : 'pointer' }}
                    >
                      {L.delete}
                    </button>
                  </span>
                </span>
              </span>
            </span>
          </div>
        );
      })}
    </section>
  );
}

// Project memory: the link into the memory viewer, plus the files that changed most recently (the
// memory.tree modification times). The viewer has no per-file deep link, so the rows only inform.
function MemorySection({ files, now, onOpen }: { files: RecentMemoryFile[]; now: number; onOpen: () => void }): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  return (
    <section data-overview-memory="">
      <SectionHead
        title={L.projectMemory}
        action={
          <button type="button" className="content-text-action" aria-label={L.ovOpenMemoryViewer} title={L.ovOpenMemoryViewer} onClick={onOpen} style={LINK}>
            {L.ovOpen} ›
          </button>
        }
      />
      {files.map((file) => (
        <div key={file.path} className="ov-row" title={file.path}>
          <IconCell><FileIcon /></IconCell>
          <span style={{ ...ELLIPSIS, color: 'var(--proto-ink)' }}>{file.name}</span>
          <span style={{ ...META, marginLeft: 'auto', flex: 'none', paddingLeft: 12 }}>{relTime(file.modifiedAt, now, lang)}</span>
        </div>
      ))}
    </section>
  );
}

export function OverviewView(): JSX.Element {
  const L = useVocab();
  const navigate = useNavigate();
  // One minute tick for every age on the page, the same cadence the rail's ages use.
  const now = useNowTick(true, 60_000);
  const { open: openExecutionDrawer } = useExecutionDrawer();
  const { open: openScheduleModal, openEdit: openScheduleEditor } = useScheduleModal();
  const { open: openIssues } = useIssues();
  const { openSection } = useSettings();
  const { openBoard } = useDockIntake();
  const notes = useNotes();

  // Active project = the shared cross-pane current project (task 569c) — the same value the LeftRail
  // switcher writes, so the overview always shows the project selected in the rail.
  const { currentProjectId: projectId, setCurrentProject } = useCurrentProject();
  const { setSelectedSession } = useSelectedSession();
  const data = useOverviewData(projectId);

  // The rail's own two writes for opening a session, then the workbench that shows it.
  const openSession = (row: OverviewSessionRow) => {
    setCurrentProject(row.projectId);
    setSelectedSession(row.sessionId);
    navigate('/workbench');
  };
  // File → New session's draft: the current project is already this one.
  const newSessionHere = () => {
    setSelectedSession(DRAFT_SENTINEL);
    navigate('/workbench');
  };
  // The dock lives on the workbench, so a board opens there — as from the command palette.
  const viewBoard = (row: PendingDecisionsRow) => {
    navigate('/workbench');
    openBoard(row.boardId);
  };
  const deleteSchedule = async (s: ScheduleInfo) => {
    if (data.removeSchedule.isPending) return;
    const confirmed = await confirmDialog({
      title: L.scDeleteTitle, description: s.message, confirmLabel: L.delete, tone: 'danger',
    });
    if (confirmed) data.removeSchedule.mutate({ scheduleId: s.id });
  };
  const resumeSchedule = (s: ScheduleInfo) => {
    if (!data.resumeSchedule.isPending) data.resumeSchedule.mutate({ scheduleId: s.id });
  };

  return (
    // No background of its own: the overview reads directly on the workspace pane's glass, the same
    // way the chat transcript does.
    <div className="content-surface ov-root" data-pane="center" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="ov-header">
        <IconButton label={L.back} size={28} onClick={() => navigate('/workbench')}>
          <ChevronLeftIcon />
        </IconButton>
        <h1 style={{ ...ELLIPSIS, margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--proto-ink)' }}>{projectId ?? '—'}</h1>
        <span style={{ flex: 'none', fontSize: 15, color: 'var(--proto-muted-3)' }}>/ {L.overview}</span>
        <span style={{ flex: 1 }} />
        <NotesButton
          className="ov-capsule"
          count={notes.vm.activeCount}
          active={notes.isOpen}
          onClick={() => notes.isOpen ? notes.close() : notes.open()}
        />
        {projectId && (
          <button type="button" className="ov-capsule" data-new-session-here="" onClick={newSessionHere}>
            <PlusIcon />
            {L.ovNewSessionHere}
          </button>
        )}
      </div>

      <div className="ov-scroll">
        <div className="ov-page">
          <div className="ov-col">
            <NeedsYouSection data={data} now={now} onReply={openSession} onViewBoard={viewBoard} />
            <InProgressSection rows={data.inProgress} now={now} onOpen={openSession} />
            <IssuesSection issues={data.issues} onOpen={openIssues} />
            <RecentRunsSection executions={data.executions} sessionsById={data.sessionsById} now={now} onLogs={openExecutionDrawer} />
          </div>
          <div className="ov-col ov-col-side">
            <OverviewSpend cost={data.cost} now={now} onAdjustBudget={() => openSection('budget')} />
            <SchedulesSection
              schedules={data.schedules}
              now={now}
              onNew={() => openScheduleModal({ projectId })}
              onEdit={openScheduleEditor}
              onDelete={deleteSchedule}
              onResume={resumeSchedule}
              deleting={data.removeSchedule.isPending}
            />
            <MemorySection files={data.memoryFiles} now={now} onOpen={() => navigate('/memory')} />
            <NotesOverviewCard vm={notes.vm} onOpen={notes.open} onAdd={notes.add} />
          </div>
        </div>
      </div>
    </div>
  );
}
