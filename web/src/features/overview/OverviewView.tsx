// input:  project cost, schedules, executions, issues and notes
// output: desktop project Overview with quick note entry
// pos:    Project dashboard center pane
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScheduleInfo, ExecutionInfo, IssueInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { useExecutionLogDrawer } from '@/features/execution/ExecutionLogDrawerProvider';
import { useScheduleModal } from '@/features/schedule/ScheduleModalProvider';
import { useIssues } from '@/features/issues/IssuesProvider';
import { useCurrentProject } from '@/features/workbench/CurrentProjectProvider';
import { NotesButton } from '@/features/notes/NotesButton';
import { NotesOverviewCard } from '@/features/notes/NotesOverviewCard';
import { useNotes } from '@/features/notes/NotesProvider';
import {
  formatMoney,
  scheduleIntervalLabel,
  scheduleProfileLabel,
  nextRunLabel,
  lastRunLabel,
  execDurationMs,
  formatDuration,
  execMachine,
  execCost,
  execStatusPill,
  execSummary,
  budgetPercent,
  formatPerDay,
  dailySeriesBars,
  dailyAverage,
  whereItGoesRows,
} from './overview-vm';

// PROJECT OVERVIEW 6a — 1:1 from prototype.dc.html L525–655 (Stage-R R2, task df67). Exact inline
// styles / px / hex / font / weight / EN copy reproduced verbatim; real tRPC data substituted into
// the design's structure: cost header (today/week/month) = real cost.summary; Schedules = real
// schedules.list; Executions = real executions.list.
//   - REAL (task 302b, CostSummary c489 fields): budget bar + `$/day` = real dailyBudget denom + today %;
//     forecast today = real forecastToday; Last 14 days = real dailyCost per-day series + real avg;
//     Where it goes = real project-scoped byTriggerScoped breakdown. Honest guards remain: absent/0
//     dailyBudget → empty bar + `—`; empty byTriggerScoped → no-spend line (never fabricated numbers).
//   - Project memory — real memory viewer link (memory.tree/memory.file fs scope).
//   - Adjust-budget + ⋯ are inert here; budgets (global and per-project) are edited in Settings ▸ Budget.

const CARD: CSSProperties = {
  background: 'var(--proto-card)',
  border: '1px solid var(--proto-line)',
  borderRadius: 10,
  boxShadow: '0 1px 2px rgba(16,24,40,.03)',
  // minWidth:0 lets the 1fr grid track shrink below its content's min-content size, so long real
  // data (schedule prompts, execution ids) truncates instead of blowing the column wide.
  minWidth: 0,
};

function CardHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '10px 14px',
        borderBottom: '1px solid var(--proto-line-2)',
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{title}</span>
      {right != null && (
        <span style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>
          {right}
        </span>
      )}
    </div>
  );
}

export function OverviewView(): JSX.Element {
  const L = useVocab();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { open: openExecutionLog } = useExecutionLogDrawer();
  const { open: openScheduleModal } = useScheduleModal();
  const { open: openIssues } = useIssues();
  const notes = useNotes();
  const now = Date.now();

  // Active project = the shared cross-pane current project (task 569c) — the same value the LeftRail
  // switcher writes and the RightPanel cost bar reads. Using it here (instead of re-deriving the
  // most-recent-session project) fixes the overview showing a different project than the one selected
  // in the rail.
  const { currentProjectId: activeProjectId } = useCurrentProject();
  const projName = activeProjectId ?? '—';

  const costQuery = useQuery({
    ...trpc.cost.summary.queryOptions({ projectId: activeProjectId ?? undefined }),
    enabled: !!activeProjectId,
  });
  const cost = costQuery.data;

  // Real cost-derived view models (task 302b). budgetPct is null when there is no daily-budget
  // denominator → the bar renders empty. dailyBars / avg / whereRows are the honest empty [] / null
  // when the scoped series or breakdown carries no spend.
  const budgetPct = budgetPercent(cost?.today, cost?.dailyBudget);
  const dailyBars = useMemo(() => dailySeriesBars(cost?.dailyCost), [cost?.dailyCost]);
  const avgPerDay = useMemo(() => dailyAverage(cost?.dailyCost), [cost?.dailyCost]);
  const whereRows = useMemo(() => whereItGoesRows(cost?.byTriggerScoped, 'week'), [cost?.byTriggerScoped]);

  const schedulesQuery = useQuery({
    ...trpc.schedules.list.queryOptions({ projectId: activeProjectId ?? undefined }),
    enabled: !!activeProjectId,
  });
  const schedules = schedulesQuery.data ?? [];

  // executions.list has no projectId filter → fetch recent and filter client-side by project.
  const executionsQuery = useQuery(trpc.executions.list.queryOptions({ limit: 50 }));
  const executions = useMemo<ExecutionInfo[]>(() => {
    const all = executionsQuery.data ?? [];
    const scoped = activeProjectId ? all.filter((e) => e.projectId === activeProjectId) : all;
    return scoped.slice(0, 6);
  }, [executionsQuery.data, activeProjectId]);

  // Issues (design sec-24 24a): per-project ISSUES.md entries. Count stat hidden at 0; card hidden
  // at 0 too (为 0 时整项隐藏).
  const issuesQuery = useQuery({
    ...trpc.issues.list.queryOptions({ projectId: activeProjectId ?? '' }),
    enabled: !!activeProjectId,
  });
  const issues = useMemo<IssueInfo[]>(() => issuesQuery.data ?? [], [issuesQuery.data]);

  const resume = useMutation(
    trpc.schedules.resume.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.schedules.list.queryFilter());
      },
    }),
  );

  return (
    <div data-pane="center" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--proto-card)' }}>
      {/* header bar (prototype L526–556) */}
      <div
        style={{
          height: 50,
          flex: 'none',
          borderBottom: '1px solid var(--proto-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 20px',
          background: 'var(--proto-card)',
        }}
      >
        <span
          onClick={() => navigate('/workbench')}
          style={{ fontSize: 14, color: 'var(--proto-muted)', cursor: 'pointer', padding: '4px 8px 4px 0' }}
        >
          ‹
        </span>
        <span style={{ font: "500 12px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-2)' }}>{projName}</span>
        <span style={{ color: 'var(--proto-line-3)' }}>/</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.overview}</span>
        <span style={{ position: 'relative', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {/* Issues stat (24a): count from ISSUES.md, hidden at 0; click opens the 24b modal */}
          {issues.length > 0 && (
            <span
              data-issues-stat=""
              onClick={() => openIssues()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                font: "500 10px 'IBM Plex Mono',monospace",
                color: 'var(--proto-muted)',
                padding: '3px 8px',
                cursor: 'pointer',
              }}
            >
              <b style={{ color: 'var(--proto-accent)' }}>{issues.length}</b> {L.issuesStat}
            </span>
          )}
          <span style={{ width: 1, height: 18, background: 'var(--proto-line)', flex: 'none' }} />
          <NotesButton
            count={notes.vm.activeCount}
            active={notes.isOpen}
            copy={notes.copy}
            onClick={() => notes.isOpen ? notes.close() : notes.open()}
          />
          {/* Adjust budget — no budget-mutate scope, inert (GAP, Stage 7) */}
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              border: '1px solid var(--proto-line-3)',
              borderRadius: 7,
              padding: '4px 12px',
              color: 'var(--proto-ink)',
              background: 'var(--proto-card)',
              cursor: 'pointer',
            }}
          >
            {L.adjustBudget}
          </span>
          {/* ⋯ overflow menu — decorative for this view */}
          <span style={{ color: 'var(--proto-muted-2)', fontSize: 15, letterSpacing: 1, padding: '2px 6px', borderRadius: 6, cursor: 'pointer' }}>
            ⋯
          </span>
        </span>
      </div>

      {/* cost summary bar (prototype L557–563) */}
      <div
        style={{
          flex: 'none',
          borderBottom: '1px solid var(--proto-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 30,
          padding: '12px 20px 14px',
          background: 'var(--proto-card)',
        }}
      >
        <div style={{ minWidth: 180 }}>
          <div style={{ fontSize: 10, color: 'var(--proto-muted-3)', marginBottom: 3 }}>{L.today}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ font: "600 22px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)', letterSpacing: '-.02em' }}>
              {formatMoney(cost?.today)}
            </span>
            {/* budget progress bar — REAL: today's scoped spend as % of the daily budget (empty when
                there is no positive daily-budget denominator, honest placeholder) */}
            <div style={{ flex: 1, height: 5, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden', marginTop: 2 }}>
              <div style={{ width: `${budgetPct ?? 0}%`, height: '100%', background: 'var(--proto-accent)' }} />
            </div>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--proto-muted-3)', marginBottom: 3 }}>{L.thisWeek}</div>
          <div style={{ font: "600 15px 'IBM Plex Mono',monospace", color: 'var(--proto-ink-2)' }}>{formatMoney(cost?.week)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--proto-muted-3)', marginBottom: 3 }}>{L.month}</div>
          <div style={{ font: "600 15px 'IBM Plex Mono',monospace", color: 'var(--proto-ink-2)' }}>{formatMoney(cost?.month)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--proto-muted-3)', marginBottom: 3 }}>{L.budgetPerDay}</div>
          {/* REAL: dailyBudget from budget.json, scope-resolved (this project's override when it
              has one, else the global cap). `—` when unset (honest). */}
          <div style={{ font: "600 15px 'IBM Plex Mono',monospace", color: 'var(--proto-ink-2)' }}>
            {formatPerDay(cost?.dailyBudget)}
            <span style={{ fontSize: 10, color: 'var(--proto-muted-3)', fontWeight: 400 }}> {L.perDay}</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: 'var(--proto-muted-3)', marginBottom: 3 }}>{L.forecastToday}</div>
          {/* REAL: forecastToday = scoped spend extrapolated by elapsed fraction of the local day */}
          <div style={{ font: "600 15px 'IBM Plex Mono',monospace", color: 'var(--proto-amber-text)' }}>{formatMoney(cost?.forecastToday)}</div>
        </div>
      </div>

      {/* card grid (prototype L564–655) */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          minHeight: 0,
          padding: '14px 20px',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridAutoRows: 'min-content',
          gap: 12,
          background: 'var(--proto-alt)',
          alignContent: 'start',
        }}
      >
        {/* Last 14 days — REAL: per-calendar-day scoped cost series (oldest→newest, last = today),
            normalized to the series max; the today bar carries its real cost label. avg = real mean. */}
        <div style={CARD}>
          <CardHeader title={L.ovLast14Days} right={`${L.ovAvg} ${avgPerDay == null ? '—' : formatMoney(avgPerDay)}${L.perDay}`} />
          <div style={{ padding: '14px 14px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 96 }}>
              {dailyBars.map((bar) =>
                bar.isToday ? (
                  <div
                    key={bar.date}
                    title={`${bar.date} · ${formatMoney(bar.cost)}`}
                    style={{ flex: 1, position: 'relative', background: 'var(--proto-accent)', borderRadius: '3px 3px 0 0', height: `${bar.pct}%` }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        bottom: '100%',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        marginBottom: 5,
                        font: "600 9.5px 'IBM Plex Mono',monospace",
                        color: 'var(--proto-accent)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatMoney(bar.cost)}
                    </div>
                  </div>
                ) : (
                  <div
                    key={bar.date}
                    title={`${bar.date} · ${formatMoney(bar.cost)}`}
                    style={{ flex: 1, background: 'var(--proto-line-4)', borderRadius: '3px 3px 0 0', height: `${bar.pct}%` }}
                  />
                ),
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 7, font: "400 9px 'IBM Plex Mono',monospace", color: 'var(--proto-faint)' }}>
              <span>{dailyBars[0]?.date ?? '—'}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontWeight: 600 }}>{L.today}</span>
            </div>
          </div>
        </div>

        {/* Project memory — REAL: memory viewer 7b now backed by the memory.tree/memory.file fs scope */}
        <div style={{ ...CARD, cursor: 'pointer' }} onClick={() => navigate('/memory')}>
          <CardHeader title={L.projectMemory} right={L.ovGitBacked} />
          <div style={{ padding: '18px 14px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-accent)' }}>{L.ovOpenMemoryViewer} ›</div>
            <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', lineHeight: 1.5 }}>
              {L.ovMemoryDesc}
            </div>
          </div>
        </div>

        <NotesOverviewCard
          vm={notes.vm}
          copy={notes.copy}
          onOpen={notes.open}
          onAdd={notes.add}
        />

        {/* Issues (design sec-24 24a) — per-project ISSUES.md entries; rows open the 24b modal
            located at that entry. No status labels (在列表即待处理). Hidden entirely at 0. The
            design mock's source slot has no markdown field → only title + date (honest). */}
        {issues.length > 0 && (
          <div style={CARD} data-issues-card="">
            <CardHeader title={L.issuesTitle} right="ISSUES.md" />
            <div style={{ padding: '4px 14px 6px' }}>
              {issues.slice(0, 3).map((i, idx) => (
                <div
                  key={i.id}
                  onClick={() => openIssues(i.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '8px 0',
                    borderBottom: idx < Math.min(issues.length, 3) - 1 ? '1px solid var(--proto-alt)' : 'none',
                    cursor: 'pointer',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--proto-muted-2)" strokeWidth="1.5" style={{ flex: 'none' }}>
                    <circle cx="7" cy="7" r="5.5" />
                    <path d="M7 4.2v3.3" />
                    <circle cx="7" cy="9.8" r=".4" fill="var(--proto-muted-2)" />
                  </svg>
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: 'var(--proto-ink-2)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {i.title}
                  </span>
                  {i.date && (
                    <span style={{ font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-faint)', flex: 'none' }}>
                      {i.date}
                    </span>
                  )}
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-accent)', flex: 'none' }}>↗</span>
                </div>
              ))}
            </div>
            <div
              onClick={() => openIssues()}
              style={{
                borderTop: '1px solid var(--proto-line-2)',
                padding: '9px 14px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--proto-accent)',
                cursor: 'pointer',
              }}
            >
              {L.isViewAll} {issues.length} ›
            </div>
          </div>
        )}

        {/* Where it goes — REAL: project-scoped byTriggerScoped weekly breakdown. Rows are real trigger
            names (not the prototype's mock threads/sessions/schedules labels), sorted desc + capped;
            proportional bars. Empty → honest no-spend line (never fabricated bars). */}
        <div style={CARD}>
          <CardHeader title={L.ovWhereItGoes} right={L.thisWeek} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '13px 14px 14px' }}>
            {whereRows.length === 0 && (
              <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', padding: '2px 0' }}>{L.ovNoSpend}</div>
            )}
            {whereRows.map((row, i) => (
              <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span
                  title={row.label}
                  style={{
                    fontSize: 10.5,
                    color: 'var(--proto-muted)',
                    width: 56,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {row.label}
                </span>
                <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${row.pct}%`,
                      height: '100%',
                      background: ['var(--proto-accent)', 'var(--proto-accent-2)', 'var(--proto-accent-bg)'][i % 3],
                    }}
                  />
                </div>
                <span style={{ font: "500 10px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)', width: 40, textAlign: 'right' }}>
                  {formatMoney(row.cost)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Schedules — REAL schedules.list */}
        <div style={CARD}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--proto-line-2)' }}>
            <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.scheduleCard}</span>
            {/* + New — opens the New-schedule overlay (design 7c), real schedules.add */}
            <span
              onClick={() => openScheduleModal({ projectId: activeProjectId })}
              style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}
            >
              + {L.newSchedule}
            </span>
          </div>
          <div style={{ padding: '9px 14px 11px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            {schedules.length === 0 && (
              <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', padding: '4px 0' }}>{L.ovNoSchedules}</div>
            )}
            {schedules.map((s: ScheduleInfo, idx: number) => (
              <div key={s.id}>
                {idx > 0 && <div style={{ height: 1, background: 'var(--proto-line-soft)', margin: '0 0 9px' }} />}
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={s.paused ? 'var(--proto-muted-2)' : 'var(--proto-muted)'} strokeWidth="1.5">
                    <circle cx="7" cy="7" r="5.6" />
                    <path d="M7 4v3.2l2.2 1.3" />
                  </svg>
                  <span
                    title={s.message}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: s.paused ? 'var(--proto-muted-2)' : 'var(--proto-ink)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {s.message}
                  </span>
                  {s.paused && (
                    <span style={{ fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 999, background: 'var(--proto-gray)', color: 'var(--proto-muted-2)' }}>
                      {L.paused}
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>
                    {scheduleIntervalLabel(s)}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 10, color: 'var(--proto-muted-2)', marginTop: 2, paddingLeft: 18 }}>
                  <span>
                    {s.paused
                      ? `${lastRunLabel(s.lastRun, now)}`
                      : `${nextRunLabel(s.nextRun, now)} · ${lastRunLabel(s.lastRun, now)}`}
                  </span>
                  {/* Real agent profile from ScheduleInfo.profile (schedule config source). Omitted
                      when the schedule has no recorded profile — honest placeholder, no fabrication. */}
                  {scheduleProfileLabel(s) && (
                    <span
                      title="profile"
                      style={{ marginLeft: 7, font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}
                    >
                      {scheduleProfileLabel(s)}
                    </span>
                  )}
                  {s.paused && (
                    <span
                      onClick={() => !resume.isPending && resume.mutate({ scheduleId: s.id })}
                      style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}
                    >
                      {L.resume}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Executions — REAL executions.list (span 2) */}
        <div style={{ ...CARD, gridColumn: 'span 2', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--proto-line-2)' }}>
            <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.execFlow}</span>
            <span style={{ font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)', marginLeft: 8 }}>{L.ovExecSubtitle}</span>
            <span style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-faint)' }}>executions.json</span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '88px 1fr 76px 52px 56px 86px 46px',
              padding: '6px 14px',
              borderBottom: '1px solid var(--proto-line-soft)',
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: '.05em',
              color: 'var(--proto-muted-3)',
            }}
          >
            <span>{L.ovColId}</span>
            <span>{L.ovColSummary}</span>
            <span>{L.ovColMachine}</span>
            <span>{L.ovColDur}</span>
            <span>{L.ovColCost}</span>
            <span>{L.ovColStatus}</span>
            <span />
          </div>
          {executions.length === 0 && (
            <div style={{ padding: '10px 14px', fontSize: 10.5, color: 'var(--proto-faint)' }}>{L.ovNoExecutions}</div>
          )}
          {executions.map((x: ExecutionInfo) => {
            const pill = execStatusPill(x.status);
            return (
              <div
                key={x.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '88px 1fr 76px 52px 56px 86px 46px',
                  padding: '7.5px 14px',
                  borderBottom: '1px solid var(--proto-alt)',
                  alignItems: 'center',
                  fontSize: 11,
                  color: 'var(--proto-ink-2)',
                }}
              >
                <span
                  title={x.id}
                  style={{
                    font: "400 10px 'IBM Plex Mono',monospace",
                    color: 'var(--proto-muted)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    paddingRight: 8,
                  }}
                >
                  {x.id}
                </span>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 12 }}>
                  {execSummary(x)}
                </span>
                <span style={{ font: "400 10px 'IBM Plex Mono',monospace" }}>{execMachine(x)}</span>
                <span style={{ font: "400 10px 'IBM Plex Mono',monospace" }}>{formatDuration(execDurationMs(x, now))}</span>
                <span style={{ font: "400 10px 'IBM Plex Mono',monospace" }}>{execCost(x.cost)}</span>
                <span>
                  <span style={{ fontSize: 9, fontWeight: 600, padding: '1.5px 7px', borderRadius: 999, background: pill.bg, color: pill.color }}>
                    {pill.dot ? '• ' : ''}
                    {pill.text}
                  </span>
                </span>
                <span
                  onClick={() => openExecutionLog(x.id)}
                  style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}
                >
                  {L.ovLogs}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
