# features/overview/ — Project Overview 6a center view (Stage-R R2)

The `/overview` route: the project **Overview** as a center-column view inside the workbench frame,
rebuilt 1:1 from `design/ref/prototype.dc.html` L525–655 (plan §8.5 Overview row, task df67). Reuses
the 1:1 `LeftRail` (f528) + `RightPanel` (1e96); only the center pane swaps to `OverviewView`,
mirroring the prototype's `isOverview` state. Diffed vs `proto-shots/10-overview.png`.

## Layout

| path | role |
|---|---|
| `OverviewPage.tsx` | Route `/overview`. The 240/fluid/400 flex frame (same as `WorkbenchPage`) assembling `<LeftRail/> <OverviewView/> <RightPanel/>`. |
| `OverviewView.tsx` | The center pane 1:1 (prototype L525–655): header bar (‹ back → `/workbench` · projName · Overview · Adjust-budget · ⋯) + cost summary bar + 2-col card grid (Last-14-days · Project memory · Where-it-goes · Schedules · Executions span-2). Exact inline styles/px/hex/font/weight/EN copy; real tRPC data substituted. |
| `overview-vm.ts` | **Pure** VM helpers (TDD): `formatMoney` · `deriveActiveProjectId` (mirrors LeftRail) · `scheduleIntervalLabel` · `scheduleProfileLabel` (real `ScheduleInfo.profile`, `''` when absent) · `nextRunLabel`/`lastRunLabel` (relative humanize) · `execDurationMs`/`formatDuration` · `execMachine`/`execCost`/`execStatusPill` (verbatim §5 pill hexes)/`execSummary` · **real cost fields (task 302b)** `budgetPercent` (today ÷ dailyBudget, clamp [0,100], `null` when no positive denom) · `formatPerDay` (dailyBudget or `—`) · `dailySeriesBars` (14-day series → bars normalized to series max + `isToday`) · `dailyAverage` (series mean or `null`) · `whereItGoesRows` (byTriggerScoped → weekly rows, drop-zero + sort-desc + cap 5 + proportional pct). Nested cost types reached via indexed access on `CostSummary` (no ui-contract re-export churn). |
| `overview-vm.test.ts` | Unit tests for project selection, schedule/execution derivation, cost math, series normalization, and breakdown ordering; palette values are not asserted. |

## Real data vs data-gap placeholders

- **REAL**: cost header today/week/month = `cost.summary({projectId})` (project-scoped); **Schedules** =
  `schedules.list({projectId})` (name · interval-label · next-in/last · **agent profile** (real
  `ScheduleInfo.profile` from the schedule config source, via `scheduleProfileLabel`; chip omitted when
  the schedule has no recorded profile — honest placeholder) · paused badge + **Resume** =
  real `schedules.resume` mutation → invalidate `schedules.list`); **Executions** = `executions.list`
  filtered client-side by project (id · summary · machine · dur · cost · status pill · Logs →
  `useExecutionLogDrawer().open(id)`, the b963 execution-log drawer overlay). Active project =
  the shared cross-pane current project (`useCurrentProject`, task 569c) — the same value the LeftRail
  switcher writes, so opening the overview after switching projects scopes to the selected project
  (previously it re-derived the most-recent-session project via `deriveActiveProjectId` and could show
  a different project than the rail).
- **REAL cost (task 302b, backed by the `CostSummary` c489 fields)**: **budget bar** = today's scoped
  spend as a % of `dailyBudget` (`budgetPercent`); **`budget /day`** = real `dailyBudget` (`formatPerDay`);
  **`forecast today`** = real `forecastToday`; **Last 14 days** = real `dailyCost` per-calendar-day series
  (`dailySeriesBars`, normalized to the series max, today bar carries its real cost label) + real `avg`
  (`dailyAverage`); **Where it goes** = real project-scoped `byTriggerScoped` weekly breakdown
  (`whereItGoesRows`, real trigger names — not the prototype's mock threads/sessions/schedules labels —
  sorted desc, capped, proportional bars). **Honest guards** (never fabricated): absent/0 `dailyBudget`
  → empty bar + `—`; empty `byTriggerScoped` → "No spend recorded this week." line. NOTE `dailyBudget` is
  the global `budget.json` daily cap while `today` is project-scoped — the ratio mixes a system-wide
  denominator with scoped spend, by contract.
- **EXPLICIT placeholder** (mandated): **Project memory** — real memory viewer link (memory.tree/
  memory.file fs scope). Adjust-budget + ⋯ are inert (no budget-mutate scope). The Schedules `+ New`
  opens the New-schedule overlay (`features/schedule`, real `schedules.add`).

## Notes

- ui-service contract used: `projects.list`/`sessions.list`/`cost.summary` (incl. the c489 additive
  `dailyBudget`/`forecastToday`/`dailyCost`/`byTriggerScoped` fields, type-only re-exported by
  `@cortex-agent/ui-contract`)/`schedules.list`/`schedules.resume`/`executions.list`, plus the
  `ScheduleInfo.profile` field. No backend change in task 302b — the cost fields already flow.
