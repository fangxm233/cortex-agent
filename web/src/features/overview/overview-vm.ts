import type {
  BoardDecisionEntry,
  BoardInfo,
  ScheduleInfo,
  ExecutionInfo,
  CostSummary,
  SessionInfo,
} from '@cortex-agent/ui-contract';
import { formatUsd } from '@/lib/format';
import { clockTime, dayLabel, timeAgo, timeUntil, type TimeLang } from '@/i18n/time-format';
import { execStatusWord } from '@/features/execution/execution-drawer-view';
import { decisionStatus } from '@/features/session/interaction/decision-vm';
import { shortSessionId } from '@/features/session/metadata/short-session-id';
import { effectiveMs } from '@/features/session/list/session-groups';
import { teamRoster, teamSummaryText } from '@/features/team/worker-roster';
import { groupWorkers } from '@/features/team/worker-groups';
import { sessionRollup, type WorkerRollup } from '@/features/team/worker-rollup';
import { leadRow } from '@/features/workbench/rail/worker-rail';
import type { MemoryTreeFacts } from '@/features/memory/memory-tree';
import { sessionTitle } from '@/features/workbench/rail/rail-tree';
import { fmt, type Vocab } from '@/i18n';

// Pure view-model helpers for the project Overview. No JSX and no colours: the view maps the
// states these return onto theme tokens.

/** `$4.21` — two decimals, null/undefined → `$0.00`. */
export function formatMoney(n: number | null | undefined): string {
  return formatUsd(n ?? 0);
}

// ── Real cost fields (task 302b) — backed by the CostSummary c489 additions:
//    dailyBudget / forecastToday / dailyCost (14-day series) / byTriggerScoped (where-it-goes).
//    Nested element/value types are reached via indexed access on CostSummary so ui-contract needs
//    no extra re-export (DailyCostPoint / PeriodBucket are not exported by name).

type DailyCost = CostSummary['dailyCost'];
type TriggerBreakdown = CostSummary['byTriggerScoped'];

/** How many where-it-goes trigger rows fit the card before truncating. */
const WHERE_IT_GOES_MAX_ROWS = 5;

/**
 * Today's scoped spend as a percent of the daily budget, clamped to [0, 100]. Returns `null` when
 * the budget is absent or non-positive (no denominator → the bar renders empty, honest placeholder).
 * NOTE: `dailyBudget` is resolved server-side against the same scope as `today` — a project's own
 * `budget.json` override when it has one, the global cap when it inherits. Numerator and
 * denominator therefore describe the same scope.
 */
export function budgetPercent(
  today: number | null | undefined,
  dailyBudget: number | null | undefined,
): number | null {
  if (dailyBudget == null || dailyBudget <= 0) return null;
  const pct = ((today ?? 0) / dailyBudget) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** The `budget` column value, e.g. `$50.00` (`/day` suffix rendered separately). `—` when absent. */
export function formatPerDay(dailyBudget: number | null | undefined): string {
  if (dailyBudget == null || dailyBudget <= 0) return '—';
  return formatMoney(dailyBudget);
}

export interface DailyBar {
  /** Bar height as a percent of the series max cost (0 when the series max is 0). */
  pct: number;
  /** `YYYY-MM-DD` local calendar day. */
  date: string;
  /** Real cost for this day. */
  cost: number;
  /** True for the last (most-recent) point — today. */
  isToday: boolean;
}

/**
 * Map the real 14-day cost series (oldest→newest, last = today) to bar descriptors normalized to the
 * series max. Empty/undefined → `[]`; an all-zero series → all `0%` (no div-by-zero / NaN).
 */
export function dailySeriesBars(dailyCost: DailyCost | null | undefined): DailyBar[] {
  if (!dailyCost || dailyCost.length === 0) return [];
  const max = dailyCost.reduce((m, d) => Math.max(m, d.cost), 0);
  const last = dailyCost.length - 1;
  return dailyCost.map((d, i) => ({
    pct: max > 0 ? (d.cost / max) * 100 : 0,
    date: d.date,
    cost: d.cost,
    isToday: i === last,
  }));
}

/** Mean cost across the 14-day series; `null` for an empty/undefined series. */
export function dailyAverage(dailyCost: DailyCost | null | undefined): number | null {
  if (!dailyCost || dailyCost.length === 0) return null;
  const sum = dailyCost.reduce((s, d) => s + d.cost, 0);
  return sum / dailyCost.length;
}

export interface WhereItGoesRow {
  /** Trigger name (real, free-form key). */
  label: string;
  /** This-week scoped cost for the trigger. */
  cost: number;
  /** Share of the shown rows' total spend, as a percent. */
  pct: number;
}

/**
 * Project-scoped "where it goes" rows from the real `byTriggerScoped` breakdown. Reads each bucket's
 * weekly spend (the card header reads "this week"), drops zero-spend triggers, sorts desc, caps to
 * what fits the card, and computes each row's share of the shown total. Empty/undefined → `[]` (the
 * card then shows an honest no-spend line — never fabricated bars).
 */
export function whereItGoesRows(byTriggerScoped: TriggerBreakdown | null | undefined): WhereItGoesRow[] {
  if (!byTriggerScoped) return [];
  const entries = Object.entries(byTriggerScoped)
    .map(([label, bucket]) => ({ label, cost: bucket.week }))
    .filter((e) => e.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, WHERE_IT_GOES_MAX_ROWS);
  const total = entries.reduce((s, e) => s + e.cost, 0);
  return entries.map((e) => ({
    label: e.label,
    cost: e.cost,
    pct: total > 0 ? (e.cost / total) * 100 : 0,
  }));
}

/** Omit the chip when no concrete model selection was recorded. */
export function scheduleModelLabel(s: ScheduleInfo): string {
  return s.selection?.model ?? '';
}

/** `next in 19h` / `due` / `—` · `19小时后` / `到期` / `—`. */
export function nextRunLabel(nextRun: string | null, now: number, lang: TimeLang, L: Vocab): string {
  if (!nextRun) return '—';
  if (Date.parse(nextRun) - now <= 0) return L.ovNextDue;
  return fmt(L.ovNextIn, { until: timeUntil(nextRun, now, lang) });
}

/** `last 2h ago` / `never run` · `上次 2小时前` / `从未运行`. Outcome text ("✓ 3 papers") is not exposed — flagged. */
export function lastRunLabel(lastRun: string | null, now: number, lang: TimeLang, L: Vocab): string {
  const ago = timeAgo(lastRun, now, lang);
  if (!ago) return L.ovNeverRun;
  return fmt(L.ovLastRun, { ago });
}

/** Real elapsed: durationMs when finished, else (now − startedAt) for a live run. */
export function execDurationMs(e: ExecutionInfo, now: number): number | null {
  if (typeof e.durationMs === 'number') return e.durationMs;
  if (e.startedAt) return Math.max(0, now - Date.parse(e.startedAt));
  return null;
}

export function execCost(cost: number | null): string {
  return cost == null ? '—' : formatUsd(cost);
}

/**
 * Fallback name for an execution whose session is not in the client's session lists (a thread
 * run, or a session that has since been deleted): the short id, the way the rail names an
 * unlabeled session. ExecutionInfo has no summary text of its own.
 */
export function execSummary(e: ExecutionInfo, L: Vocab): string {
  if (e.sessionId) return fmt(L.ovSummarySession, { id: shortSessionId(e.sessionId) });
  return L.ovSummaryExec;
}

/** When something happened, for a list column: `16:31` today, otherwise the day (`Yesterday` / `Sep 24`). */
export function clockOrDayLabel(iso: string, now: number, lang: TimeLang): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const day = dayLabel(t, new Date(now), lang);
  return day === dayLabel(now, new Date(now), lang) ? clockTime(t) : day;
}

/** A recent-runs row's leading mark. `scheduled` is a finished run a schedule fired — the clock
 *  says where it came from; a scheduled run that failed still shows `failed`. */
export type ExecMark = 'running' | 'done' | 'scheduled' | 'failed' | 'stopped';

export interface ExecRowVm {
  id: string;
  /** The session's rail title, or the short-id fallback when the session is not known here. */
  title: string;
  /** Where the run came from, when the session record says: a team worker or a schedule. */
  tag: string | null;
  mark: ExecMark;
  /** The status in words, for the mark's accessible name. */
  statusWord: string;
  duration: number | null;
  cost: string;
  time: string;
}

function execMark(e: ExecutionInfo, session: SessionInfo | undefined): ExecMark {
  switch (e.status) {
    case 'running': return 'running';
    case 'completed': return session?.origin === 'scheduled' ? 'scheduled' : 'done';
    case 'failed': return 'failed';
    default: return 'stopped';
  }
}

/**
 * Recent-runs rows. An execution carries only its session id, so the title, the worker/schedule
 * tag and the scheduled mark all come from the session lists the rail already holds. Exit codes
 * and turn numbers are not on ExecutionInfo, so a row never shows them.
 */
export function execRows(
  executions: ExecutionInfo[],
  sessionsById: ReadonlyMap<string, SessionInfo>,
  now: number,
  lang: TimeLang,
  L: Vocab,
): ExecRowVm[] {
  return executions.map((e) => {
    const session = e.sessionId ? sessionsById.get(e.sessionId) : undefined;
    const tag = session?.teamLeadId ? L.ovTagWorker : session?.origin === 'scheduled' ? L.wbSchedGroup : null;
    return {
      id: e.id,
      title: session ? sessionTitle(session) : execSummary(e, L),
      tag,
      mark: execMark(e, session),
      statusWord: execStatusWord(e.status, L),
      duration: execDurationMs(e, now),
      cost: execCost(e.cost),
      time: clockOrDayLabel(e.startedAt, now, lang),
    };
  });
}

// ── Needs you / In progress — one row per session, in the rail's dot language. Both lists come
//    from the same sessions.list snapshot the rail renders and roll a lead up from its workers the
//    way the rail does, so the page and the rail never show the same session with different dots.

export type OverviewSessionState = 'you' | 'running' | 'waiting';

export interface OverviewSessionRow {
  sessionId: string;
  projectId: string;
  title: string;
  state: OverviewSessionState;
  /** In progress: what the session is doing or waiting on, when the record says. */
  doing: string | null;
  /** Last activity (ms), the same stamp the rail's age reads. */
  at: number;
}

export interface OverviewSessionGroups {
  needsYou: OverviewSessionRow[];
  inProgress: OverviewSessionRow[];
}

/**
 * The rail's dot for a row (RailTree), in its priority order: amber while blocked on you, the
 * accent while running, a still ring while waiting on a machine; an idle row has none.
 */
export function railDotState(r: WorkerRollup): OverviewSessionState | null {
  if (r.awaitingInput) return 'you';
  if (r.running) return 'running';
  return r.waitingOn ? 'waiting' : null;
}

function waitingText(n: number, L: Vocab): string {
  return n === 1 ? L.ovWaitingOne : fmt(L.ovWaitingMany, { n });
}

/** What an In-progress row says it is doing: its own task while it runs, its team when its dot
 *  comes from its workers (the reason the rail lights it), else what it waits on. */
function sessionDoing(
  s: SessionInfo, state: OverviewSessionState, workers: SessionInfo[], now: number, L: Vocab,
): string | null {
  if (state === 'you') return null;
  if (s.running) return s.todos?.activeLabel || s.workerBrief || (s.backgroundRunning ? L.pillBackground : null);
  const own = sessionRollup(s);
  if (workers.length > 0 && !own[state === 'running' ? 'running' : 'waitingOn']) {
    return teamSummaryText(teamRoster(workers, now).active, L);
  }
  return own.waitingOn ? waitingText(s.waitingOn ?? 0, L) : null;
}

const STATE_ORDER: Record<OverviewSessionState, number> = { you: 0, running: 1, waiting: 2 };

/**
 * Split a project's sessions into what is blocked on the user and what is still moving, with each
 * session's dot exactly as the rail draws it. In team mode the rail nests a project's workers under
 * their lead — over the non-starred direct sessions only, since a starred lead sits in Stars without
 * its workers — and the lead's row rolls theirs up (leadRow): a lead whose worker runs reads as
 * running. Every other row, workers included, shows its own state. Idle sessions are in neither
 * list. Most recent first; running ahead of waiting.
 */
export function groupSessions(
  sessions: SessionInfo[], L: Vocab, teamEnabled = false, now: number = Date.now(),
): OverviewSessionGroups {
  const unique = [...new Map(sessions.map((s) => [s.sessionId, s])).values()];
  const nesting = teamEnabled
    ? groupWorkers(unique.filter((s) => s.origin === 'direct' && s.starred !== true), now)
    : null;
  const rows: OverviewSessionRow[] = [];
  for (const s of unique) {
    const workers = nesting?.workers.get(s.sessionId) ?? [];
    const own = sessionRollup(s);
    const state = railDotState(workers.length > 0 ? leadRow(own, workers.map(sessionRollup), [], false) : own);
    if (!state) continue;
    rows.push({
      sessionId: s.sessionId,
      projectId: s.projectId,
      title: sessionTitle(s),
      state,
      doing: sessionDoing(s, state, workers, now, L),
      at: effectiveMs(s),
    });
  }
  rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.at - a.at);
  return {
    needsYou: rows.filter((r) => r.state === 'you'),
    inProgress: rows.filter((r) => r.state !== 'you'),
  };
}

/** A Needs-you row's second line: what it asks (when the pending interaction is loaded) and when. */
export function needsYouReason(question: string | undefined, at: number, now: number, lang: TimeLang): string {
  const ago = at ? timeAgo(at, now, lang) : '';
  return [question, ago].filter(Boolean).join(' · ');
}

export interface PendingDecisionsRow {
  boardId: string;
  boardTitle: string;
  /** Decisions nobody has answered yet (no approve / explain / revise). */
  pending: number;
  /** ISO ts of the newest unanswered decision. */
  latestTs: string;
}

/**
 * One row per board of the project that holds unanswered decisions. `decisions[i]` belongs to
 * `boards[i]` and is undefined while its query loads. A decision is unanswered while it carries no
 * user action — the same `none` status the decision line itself shows.
 */
export function pendingDecisionRows(
  boards: BoardInfo[],
  decisions: (BoardDecisionEntry[] | undefined)[],
): PendingDecisionsRow[] {
  const rows: PendingDecisionsRow[] = [];
  boards.forEach((board, i) => {
    const open = (decisions[i] ?? []).filter((d) => decisionStatus(d.item) === 'none');
    if (open.length === 0) return;
    const latestTs = open.reduce((max, d) => (d.ts > max ? d.ts : max), open[0].ts);
    rows.push({ boardId: board.id, boardTitle: board.title, pending: open.length, latestTs });
  });
  return rows.sort((a, b) => b.latestTs.localeCompare(a.latestTs));
}

// ── Spend ──

const TRIGGER_KEY: Record<string, 'ovTriggerChat' | 'wbSchedGroup'> = {
  user: 'ovTriggerChat',
  scheduled: 'wbSchedGroup',
};

/** Cost-record trigger names in words where the UI has them; other triggers keep their raw key. */
export function triggerLabel(trigger: string, L: Vocab): string {
  const key = TRIGGER_KEY[trigger];
  return key ? L[key] : trigger;
}

// Colour follows the trigger, not its rank this week: chat is always the first series colour and
// schedules the second, whichever spent more; other triggers take the remaining slots in order.
const TRIGGER_SLOT: Record<string, number> = { user: 0, scheduled: 1 };

/** The series-colour slot of each where-it-goes row, given how many slots the palette has. */
export function triggerSlots(rows: WhereItGoesRow[], slots: number): number[] {
  let next = Object.keys(TRIGGER_SLOT).length;
  return rows.map((r) => TRIGGER_SLOT[r.label] ?? Math.min(next++, slots - 1));
}

/** True when today's projection already passes the daily budget (no budget → never over). */
export function forecastOverBudget(
  forecastToday: number | null | undefined,
  dailyBudget: number | null | undefined,
): boolean {
  return dailyBudget != null && dailyBudget > 0 && (forecastToday ?? 0) > dailyBudget;
}

/** A 14-day series date (`YYYY-MM-DD`, local) as an axis label: `Oct 5` · `10月5日`. */
export function seriesDayLabel(date: string, now: number, lang: TimeLang): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return dayLabel(new Date(y, m - 1, d).getTime(), new Date(now), lang);
}

// ── Project memory ──

export interface RecentMemoryFile {
  path: string;
  name: string;
  modifiedAt: string;
}

/** The project's most recently modified memory files, across the top level and every memory dir. */
export function recentMemoryFiles(facts: MemoryTreeFacts, limit = 3): RecentMemoryFile[] {
  const all = [...facts.topLevelFiles, ...facts.dirs.flatMap((dir) => dir.entries)];
  return all
    .filter((f) => !Number.isNaN(Date.parse(f.modifiedAt)))
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
    .slice(0, limit)
    .map((f) => ({ path: f.path, name: f.name, modifiedAt: f.modifiedAt }));
}
