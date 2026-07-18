// @ds-adherence-ignore -- mobile 10f rebuilt 1:1 from scheme.dc.html L3249–3298 (raw px/hex/svg/font
// per §8.3 — the mobile palette is not in the light `proto.*` token set).
//
// Mobile 10f 项目 Overview — the single-column compression of desktop Overview 6a (task 82ff). Exact
// inline styles / px / hex / font / weight reproduced verbatim from the scheme; real tRPC data
// substituted into the design's structure: cost header = real `cost.summary`; memory rows = real
// `memory.tree`; schedules = real `schedules.list` (+ real `schedules.resume`); exec-flow = real
// `executions.list`.
//   REAL cost fields (task bbfe, backed by the `CostSummary` c489 additions; mirrors desktop 6a 302b):
//   - budget-per-day denominator = real `dailyBudget` (`formatPerDay`; `—` when unset — honest)
//   - budget bar % = today's scoped spend ÷ `dailyBudget` (`budgetPercent`; empty bar + `—%` when no denom)
//   - Last 14 days chart = real per-calendar-day `dailyCost` series (`dailySeriesBars`, last = today)
//   - forecast today = real `forecastToday`
//   Remaining backend-uncovered fields still render as neutral placeholders, NEVER fabricated
//   numbers (precedent df67 / memory 7b):
//   - memory per-file +/- diff · 草稿 status — MemoryTree has none → badge omitted
//   - schedule last-run outcome (`✓ N 篇入库`) — ScheduleInfo has none → time-since only
//   - `全部 →` / `+ 新建` / exec `→` — no mobile memory route / schedule modal not in mobile tree /
//     no mobile executions route → inert affordances (structural 1:1, no fabricated navigation)
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScheduleInfo, ExecutionInfo, MemoryFileEntry } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { threadScopeFilter } from '@/features/workbench/scope';
import {
  deriveActiveProjectId,
  formatMoney,
  budgetPercent,
  formatPerDay,
  dailySeriesBars,
} from '@/features/overview/overview-vm';
import {
  projectAvatarInitials,
  relTimeZh,
  intervalLabelZh,
  nextRunLabelZh,
  lastRunLabelZh,
  countTodayExecutions,
  activeThreadCountLabelZh,
  budgetPercentLabel,
} from './overview-mobile-vm';

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--proto-muted-2)" strokeWidth="1.5" style={{ flex: 'none' }}>
      <path d="M3 1.5h5.5L11.5 4v8.5h-8.5z" />
      <path d="M8.5 1.5V4H11" />
    </svg>
  );
}

function ClockIcon({ stroke }: { stroke: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.5" style={{ flex: 'none' }}>
      <circle cx="7" cy="7" r="5.6" />
      <path d="M7 4v3.2l2.2 1.3" />
    </svg>
  );
}

export function MobileOverviewScreen(): JSX.Element {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const v = useVocab();
  const now = Date.now();

  const projectsQuery = useQuery(trpc.projects.list.queryOptions({}));
  const sessionsQuery = useQuery(trpc.sessions.list.queryOptions({}));
  const projects = projectsQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const activeProjectId = useMemo(
    () => deriveActiveProjectId(sessions, projects),
    [sessions, projects],
  );

  const costQuery = useQuery({
    ...trpc.cost.summary.queryOptions({ projectId: activeProjectId ?? undefined }),
    enabled: !!activeProjectId,
  });
  const cost = costQuery.data;

  // Real cost-derived view models (task bbfe). budgetPct is null when there is no positive daily-budget
  // denominator → the bar renders empty + `—%`. dailyBars is the honest empty [] when there is no series.
  const budgetPct = budgetPercent(cost?.today, cost?.dailyBudget);
  const dailyBars = useMemo(() => dailySeriesBars(cost?.dailyCost), [cost?.dailyCost]);

  const memoryQuery = useQuery({
    ...trpc.memory.tree.queryOptions({ projectId: activeProjectId ?? '' }),
    enabled: !!activeProjectId,
  });
  const files = useMemo<MemoryFileEntry[]>(
    () => (memoryQuery.data?.files ?? []).slice(0, 5),
    [memoryQuery.data],
  );

  const schedulesQuery = useQuery({
    ...trpc.schedules.list.queryOptions({ projectId: activeProjectId ?? undefined }),
    enabled: !!activeProjectId,
  });
  const schedules = schedulesQuery.data ?? [];

  // executions.list has no projectId filter → fetch recent and filter client-side.
  const executionsQuery = useQuery(trpc.executions.list.queryOptions({ limit: 50 }));
  const executions = useMemo<ExecutionInfo[]>(() => {
    const all = executionsQuery.data ?? [];
    return activeProjectId ? all.filter((e) => e.projectId === activeProjectId) : all;
  }, [executionsQuery.data, activeProjectId]);
  const todayExecCount = countTodayExecutions(executions, now);

  const threadsQuery = useQuery({
    ...trpc.threads.list.queryOptions({ status: threadScopeFilter('active') }),
    enabled: !!activeProjectId,
  });
  const activeThreadCount = (threadsQuery.data ?? []).filter(
    (t) => t.projectId === activeProjectId,
  ).length;

  const resume = useMutation(
    trpc.schedules.resume.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.schedules.list.queryFilter());
      },
    }),
  );

  const projName = activeProjectId ?? '—';

  return (
    <div
      data-screen-label="10f 移动端项目 Overview"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top)', boxSizing: 'border-box' }}
    >
      {/* header (scheme L3254–3262) */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '8px 14px 10px',
          borderBottom: '1px solid var(--proto-line)',
          background: 'var(--proto-alt)',
        }}
      >
        <span onClick={() => navigate(-1)} style={{ fontSize: 15, color: 'var(--proto-accent)', flex: 'none', cursor: 'pointer' }}>
          ‹
        </span>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: 'var(--proto-accent-bg)',
            color: 'var(--proto-accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: "600 11px 'IBM Plex Mono',monospace",
            flex: 'none',
          }}
        >
          {projectAvatarInitials(activeProjectId)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            title={projName}
            style={{
              fontSize: 15,
              fontWeight: 650,
              color: 'var(--proto-ink)',
              letterSpacing: '-.01em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {projName}
          </div>
          <div style={{ font: "400 10px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-2)', marginTop: 1 }}>
            {activeThreadCountLabelZh(activeThreadCount)}
          </div>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: 'var(--proto-card)',
            border: '1px solid var(--proto-line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--proto-muted-2)',
            fontSize: 14,
            letterSpacing: 1,
            flex: 'none',
          }}
        >
          ⋯
        </div>
      </div>

      {/* scrollable card column (scheme L3263) */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px 14px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          background: 'var(--proto-alt)',
        }}
      >
        {/* cost card (scheme L3265–3272) */}
        <div style={{ background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 14, padding: '13px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--proto-muted-3)' }}>{v.today}</span>
            {/* REAL: dailyBudget from budget.json (global daily cap). `—` when unset (honest). */}
            <span style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>
              {v.budgetPerDay} {formatPerDay(cost?.dailyBudget)}{v.perDay}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <span style={{ font: "600 24px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)', letterSpacing: '-.02em' }}>
              {formatMoney(cost?.today)}
            </span>
            {/* REAL: today's scoped spend as % of the daily budget (empty track + `—%` when no denom) */}
            <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden' }}>
              <div style={{ width: `${budgetPct ?? 0}%`, height: '100%', background: 'var(--proto-accent)' }} />
            </div>
            <span style={{ font: "400 10px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>{budgetPercentLabel(budgetPct)}</span>
          </div>
          {/* REAL: per-calendar-day scoped cost series (oldest→newest, last = today, highlighted). */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 44, marginTop: 12 }}>
            {dailyBars.map((bar) => (
              <div
                key={bar.date}
                title={`${bar.date} · ${formatMoney(bar.cost)}`}
                style={{
                  flex: 1,
                  background: bar.isToday ? 'var(--proto-accent)' : 'var(--proto-line-4)',
                  borderRadius: '2px 2px 0 0',
                  height: `${bar.pct}%`,
                }}
              />
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              marginTop: 9,
              font: "400 10px 'IBM Plex Mono',monospace",
              color: 'var(--proto-muted-3)',
            }}
          >
            <span>
              {v.thisWeek} <b style={{ color: 'var(--proto-ink-2)' }}>{formatMoney(cost?.week)}</b>
            </span>
            <span>
              {v.month} <b style={{ color: 'var(--proto-ink-2)' }}>{formatMoney(cost?.month)}</b>
            </span>
            {/* REAL: forecastToday = scoped spend extrapolated by the elapsed fraction of the local day */}
            <span style={{ marginLeft: 'auto', color: 'var(--proto-amber-text)' }}>{v.forecastToday} {formatMoney(cost?.forecastToday)}</span>
          </div>
        </div>

        {/* memory card (scheme L3274–3279) */}
        <div style={{ background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 14, overflow: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 14px',
              borderBottom: '1px solid var(--proto-line-2)',
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{v.projectMemory}</span>
            {/* inert: no mobile memory-viewer route (flagged) */}
            <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--proto-accent)' }}>{v.viewAll} →</span>
          </div>
          {files.length === 0 && <div style={{ padding: '10px 14px', fontSize: 10.5, color: 'var(--proto-faint)' }}>—</div>}
          {files.map((f, idx) => (
            <div
              key={f.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '9px 14px',
                borderBottom: idx < files.length - 1 ? '1px solid var(--proto-alt)' : undefined,
              }}
            >
              <FileIcon />
              <span
                title={f.name}
                style={{
                  flex: 1,
                  minWidth: 0,
                  font: "500 12px 'IBM Plex Mono',monospace",
                  color: 'var(--proto-ink-2)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {f.name}
              </span>
              {/* GAP: no per-file +/- diff or 草稿 status in MemoryTree → badge omitted (no fabrication) */}
              <span style={{ flex: 'none', font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-faint)' }}>
                {relTimeZh(f.modifiedAt, now)}
              </span>
            </div>
          ))}
        </div>

        {/* schedule card (scheme L3281–3290) */}
        <div style={{ background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 14, overflow: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 14px',
              borderBottom: '1px solid var(--proto-line-2)',
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{v.scheduleCard}</span>
            {/* inert: ScheduleModalProvider not mounted in the mobile tree (flagged) */}
            <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--proto-accent)' }}>+ {v.newSchedule}</span>
          </div>
          {schedules.length === 0 && <div style={{ padding: '10px 14px', fontSize: 10.5, color: 'var(--proto-faint)' }}>—</div>}
          {schedules.map((s: ScheduleInfo, idx: number) => (
            <div
              key={s.id}
              style={{
                padding: '9px 14px',
                borderBottom: idx < schedules.length - 1 ? '1px solid var(--proto-alt)' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ClockIcon stroke={s.paused ? 'var(--proto-muted-2)' : 'var(--proto-muted)'} />
                <span
                  title={s.message}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: s.paused ? 'var(--proto-muted-2)' : 'var(--proto-ink)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {s.message}
                </span>
                {s.paused ? (
                  <>
                    <span
                      style={{
                        flex: 'none',
                        fontSize: 10,
                        fontWeight: 600,
                        padding: '1.5px 7px',
                        borderRadius: 999,
                        background: 'var(--proto-gray)',
                        color: 'var(--proto-muted-2)',
                      }}
                    >
                      {v.paused}
                    </span>
                    <span
                      onClick={() => !resume.isPending && resume.mutate({ scheduleId: s.id })}
                      style={{ marginLeft: 'auto', flex: 'none', fontSize: 11, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}
                    >
                      {v.resume}
                    </span>
                  </>
                ) : (
                  <span style={{ marginLeft: 'auto', flex: 'none', font: "400 10px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>
                    {intervalLabelZh(s)}
                  </span>
                )}
              </div>
              {/* active entry sub-line; GAP: no last-run outcome text → time-since only */}
              {!s.paused && (
                <div style={{ fontSize: 11, color: 'var(--proto-muted-2)', marginTop: 3, paddingLeft: 20 }}>
                  {nextRunLabelZh(s.nextRun, now)} · {lastRunLabelZh(s.lastRun, now)}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* execution-flow row (scheme L3292) */}
        <div
          style={{
            background: 'var(--proto-card)',
            border: '1px solid var(--proto-line)',
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '11px 14px',
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{v.execFlow}</span>
          <span style={{ font: "400 10px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>
            {v.execCountUnit} {todayExecCount} 条 · {formatMoney(cost?.today)}
          </span>
          {/* inert: no mobile executions route (flagged) */}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--proto-faint)' }}>→</span>
        </div>
      </div>

      {/* home-indicator safe-area spacer (scheme L3295) — non-Tab page owns its own bottom OS inset */}
      <div style={{ flex: 'none', height: 'calc(8px + env(safe-area-inset-bottom))', background: 'var(--proto-alt)' }} />
    </div>
  );
}
