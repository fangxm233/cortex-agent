import { describe, it, expect } from 'vitest';
import type { ScheduleInfo, ExecutionInfo, SessionInfo, ProjectConduitInfo } from '@cortex-agent/ui-contract';
import {
  formatMoney,
  deriveActiveProjectId,
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

const sched = (p: Partial<ScheduleInfo>): ScheduleInfo => ({
  id: 's1',
  type: 'interval',
  message: 'x',
  projectId: 'proj',
  profile: null,
  nextRun: null,
  lastRun: null,
  paused: false,
  pausedBy: null,
  ...p,
});

const exec = (p: Partial<ExecutionInfo>): ExecutionInfo => ({
  id: 'exec_1',
  type: 'local',
  status: 'running',
  taskId: null,
  sessionId: null,
  projectId: 'proj',
  machine: null,
  startedAt: '2026-07-06T00:00:00.000Z',
  finishedAt: null,
  durationMs: null,
  cost: null,
  ...p,
});

describe('formatMoney', () => {
  it('formats two decimals with $', () => {
    expect(formatMoney(4.21)).toBe('$4.21');
    expect(formatMoney(18.6)).toBe('$18.60');
    expect(formatMoney(0)).toBe('$0.00');
  });
  it('treats null/undefined as 0', () => {
    expect(formatMoney(null)).toBe('$0.00');
    expect(formatMoney(undefined)).toBe('$0.00');
  });
});

describe('deriveActiveProjectId', () => {
  const proj = (id: string): ProjectConduitInfo => ({
    id,
    kind: 'research',
    contextDir: '/x',
    hasMission: true,
    conduits: {},
  });
  const sess = (projectId: string, lastUsedAt: string): SessionInfo => ({
    sessionId: 's-' + lastUsedAt,
    name: 'n',
    projectId,
    backend: 'claude',
    kind: 'local',
    origin: 'direct',
    createdAt: lastUsedAt,
    lastUsedAt,
    resumable: true,
    label: null,
    profileName: null,
    running: false,
    numTurns: null,
    costUsd: null,
    unread: false,
  });
  it('picks the most-recently-used session project', () => {
    const sessions = [
      sess('alpha', '2026-07-01T00:00:00Z'),
      sess('beta', '2026-07-05T00:00:00Z'),
    ];
    expect(deriveActiveProjectId(sessions, [proj('alpha'), proj('beta')])).toBe('beta');
  });
  it('falls back to first project when no sessions', () => {
    expect(deriveActiveProjectId([], [proj('gamma')])).toBe('gamma');
  });
  it('returns null when nothing available', () => {
    expect(deriveActiveProjectId([], [])).toBeNull();
  });
});

describe('scheduleIntervalLabel', () => {
  it('labels once/interval by type', () => {
    expect(scheduleIntervalLabel(sched({ type: 'once' }))).toBe('once');
    expect(scheduleIntervalLabel(sched({ type: 'interval' }))).toBe('interval');
  });
  it('prefixes daily/weekly with clock time from nextRun', () => {
    const l = scheduleIntervalLabel(sched({ type: 'daily', nextRun: '2026-07-06T07:30:00Z' }));
    expect(l.startsWith('daily ')).toBe(true);
    expect(l).toMatch(/daily \d\d:\d\d/);
    expect(scheduleIntervalLabel(sched({ type: 'weekly', nextRun: null }))).toBe('weekly');
  });
});

describe('scheduleProfileLabel', () => {
  it('returns the real profile from the schedule config source', () => {
    expect(scheduleProfileLabel(sched({ profile: 'claude-haiku' }))).toBe('claude-haiku');
  });
  it('returns empty string when the schedule has no profile (honest placeholder)', () => {
    expect(scheduleProfileLabel(sched({ profile: null }))).toBe('');
  });
});

describe('nextRunLabel', () => {
  const now = Date.parse('2026-07-06T00:00:00Z');
  it('returns em dash for null', () => {
    expect(nextRunLabel(null, now)).toBe('—');
  });
  it('humanizes future distance', () => {
    expect(nextRunLabel('2026-07-06T19:00:00Z', now)).toBe('next in 19h');
    expect(nextRunLabel('2026-07-06T00:10:00Z', now)).toBe('next in 10m');
    expect(nextRunLabel('2026-07-08T00:00:00Z', now)).toBe('next in 2d');
  });
  it('marks a due schedule', () => {
    expect(nextRunLabel('2026-07-05T23:00:00Z', now)).toBe('due');
  });
});

describe('lastRunLabel', () => {
  const now = Date.parse('2026-07-06T00:00:00Z');
  it('says never when absent', () => {
    expect(lastRunLabel(null, now)).toBe('never run');
  });
  it('humanizes past distance', () => {
    expect(lastRunLabel('2026-07-05T22:00:00Z', now)).toBe('last 2h ago');
    expect(lastRunLabel('2026-07-05T23:45:00Z', now)).toBe('last 15m ago');
  });
});

describe('execDurationMs + formatDuration', () => {
  const now = Date.parse('2026-07-06T00:05:00Z');
  it('uses durationMs when present', () => {
    expect(execDurationMs(exec({ durationMs: 120000 }), now)).toBe(120000);
  });
  it('computes elapsed from startedAt when running', () => {
    expect(execDurationMs(exec({ startedAt: '2026-07-06T00:00:00Z', durationMs: null }), now)).toBe(300000);
  });
  it('formats hours/minutes/seconds', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(45000)).toBe('45s');
    expect(formatDuration(120000)).toBe('2m');
    expect(formatDuration(21060000)).toBe('5h 51m');
  });
});

describe('execMachine / execCost', () => {
  it('defaults machine to local', () => {
    expect(execMachine(exec({ machine: null }))).toBe('local');
    expect(execMachine(exec({ machine: 'gpu-01' }))).toBe('gpu-01');
  });
  it('formats cost or em dash', () => {
    expect(execCost(null)).toBe('—');
    expect(execCost(0.38)).toBe('$0.38');
  });
});

describe('execStatusPill', () => {
  it('maps each status to prototype pill tones', () => {
    expect(execStatusPill('running').text).toBe('running');
    expect(execStatusPill('running').color).toBe('#4655D4');
    expect(execStatusPill('completed').text).toBe('done');
    expect(execStatusPill('completed').color).toBe('#23854F');
    expect(execStatusPill('failed').text).toBe('failed');
    expect(execStatusPill('failed').color).toBe('#C03D33');
    expect(execStatusPill('cancelled').text).toBe('cancelled');
    expect(execStatusPill('stale').text).toBe('stale');
  });
});

describe('execSummary', () => {
  it('prefers task, then session, then type', () => {
    expect(execSummary(exec({ taskId: 'df67', type: 'dispatch' }))).toBe('task df67');
    expect(execSummary(exec({ taskId: null, sessionId: 'cortex-9a', type: 'local' }))).toBe('session cortex-9a');
    expect(execSummary(exec({ taskId: null, sessionId: null, type: 'local' }))).toBe('local execution');
  });
});

// ── Real cost fields (task 302b, backed by CostSummary c489: dailyBudget / forecastToday /
//    dailyCost 14-day series / byTriggerScoped where-it-goes) ──

const day = (date: string, cost: number) => ({ date, cost });
const bucket = (p: Partial<{ today: number; week: number; month: number; total: number }>) => ({
  today: 0,
  week: 0,
  month: 0,
  total: 0,
  ...p,
});

describe('budgetPercent', () => {
  it('computes today over the daily budget as a percent', () => {
    expect(budgetPercent(12.5, 50)).toBe(25);
  });
  it('clamps over-budget spend to 100', () => {
    expect(budgetPercent(60, 50)).toBe(100);
  });
  it('returns null when the budget is absent or non-positive (no denominator)', () => {
    expect(budgetPercent(12.5, 0)).toBeNull();
    expect(budgetPercent(12.5, null)).toBeNull();
    expect(budgetPercent(12.5, undefined)).toBeNull();
  });
  it('treats missing today spend as zero', () => {
    expect(budgetPercent(null, 50)).toBe(0);
    expect(budgetPercent(undefined, 50)).toBe(0);
  });
});

describe('formatPerDay', () => {
  it('formats a real daily budget with $', () => {
    expect(formatPerDay(50)).toBe('$50.00');
    expect(formatPerDay(12.5)).toBe('$12.50');
  });
  it('renders an em dash when absent or non-positive (honest placeholder)', () => {
    expect(formatPerDay(0)).toBe('—');
    expect(formatPerDay(null)).toBe('—');
    expect(formatPerDay(undefined)).toBe('—');
  });
});

describe('dailySeriesBars', () => {
  it('normalizes each day to the max cost and flags the last as today', () => {
    const bars = dailySeriesBars([day('2026-07-01', 5), day('2026-07-02', 10), day('2026-07-03', 2.5)]);
    expect(bars.map((b) => b.pct)).toEqual([50, 100, 25]);
    expect(bars.map((b) => b.isToday)).toEqual([false, false, true]);
    expect(bars[2].date).toBe('2026-07-03');
    expect(bars[2].cost).toBe(2.5);
  });
  it('yields all-zero percents for an all-zero series (no NaN)', () => {
    const bars = dailySeriesBars([day('2026-07-01', 0), day('2026-07-02', 0)]);
    expect(bars.map((b) => b.pct)).toEqual([0, 0]);
  });
  it('returns [] for empty or undefined input', () => {
    expect(dailySeriesBars([])).toEqual([]);
    expect(dailySeriesBars(undefined)).toEqual([]);
  });
});

describe('dailyAverage', () => {
  it('averages the series cost', () => {
    expect(dailyAverage([day('a', 3), day('b', 5), day('c', 4)])).toBe(4);
  });
  it('returns null for an empty or undefined series', () => {
    expect(dailyAverage([])).toBeNull();
    expect(dailyAverage(undefined)).toBeNull();
  });
});

describe('whereItGoesRows', () => {
  it('maps scoped trigger buckets to weekly rows, sorted desc with proportional percents', () => {
    const rows = whereItGoesRows({
      alpha: bucket({ week: 30 }),
      beta: bucket({ week: 10 }),
    });
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'beta']);
    expect(rows.map((r) => r.cost)).toEqual([30, 10]);
    expect(rows.map((r) => r.pct)).toEqual([75, 25]);
  });
  it('drops zero-spend triggers', () => {
    const rows = whereItGoesRows({ alpha: bucket({ week: 5 }), beta: bucket({ week: 0 }) });
    expect(rows.map((r) => r.label)).toEqual(['alpha']);
    expect(rows[0].pct).toBe(100);
  });
  it('returns [] for an empty or undefined breakdown', () => {
    expect(whereItGoesRows({})).toEqual([]);
    expect(whereItGoesRows(undefined)).toEqual([]);
  });
  it('caps the number of rows shown', () => {
    const many: Record<string, ReturnType<typeof bucket>> = {};
    for (let i = 0; i < 8; i++) many['t' + i] = bucket({ week: i + 1 });
    const rows = whereItGoesRows(many);
    expect(rows.length).toBeLessThanOrEqual(5);
    // highest first
    expect(rows[0].label).toBe('t7');
  });
});
