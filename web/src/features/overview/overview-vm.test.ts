import { describe, it, expect } from 'vitest';
import type { BoardDecisionEntry, BoardInfo, ExecutionInfo, SessionInfo } from '@cortex-agent/ui-contract';
import {
  execDurationMs,
  budgetPercent,
  dailySeriesBars,
  whereItGoesRows,
  nextRunLabel,
  lastRunLabel,
  execSummary,
  execRows,
  clockOrDayLabel,
  groupSessions,
  needsYouReason,
  pendingDecisionRows,
  recentMemoryFiles,
  triggerLabel,
  triggerSlots,
  forecastOverBudget,
  seriesDayLabel,
} from './overview-vm';
import { deriveMemoryTreeFacts } from '@/features/memory/memory-tree';
import { en, zh } from '@/i18n';

const exec = (p: Partial<ExecutionInfo>): ExecutionInfo => ({
  id: 'exec_1',
  status: 'running',
  sessionId: null,
  projectId: 'proj',
  startedAt: '2026-07-06T00:00:00.000Z',
  finishedAt: null,
  durationMs: null,
  cost: null,
  ...p,
});

describe('execDurationMs', () => {
  const now = Date.parse('2026-07-06T00:05:00Z');
  it('uses durationMs when present', () => {
    expect(execDurationMs(exec({ durationMs: 120000 }), now)).toBe(120000);
  });
  it('computes elapsed from startedAt when running', () => {
    expect(execDurationMs(exec({ startedAt: '2026-07-06T00:00:00Z', durationMs: null }), now)).toBe(300000);
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

describe('schedule run labels', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  it('follows the UI language', () => {
    const next = '2026-09-27T07:00:00Z';
    const last = '2026-09-26T10:00:00Z';
    expect([nextRunLabel(next, now, 'en', en), lastRunLabel(last, now, 'en', en)]).toEqual(['next in 19h', 'last 2h ago']);
    expect([nextRunLabel(next, now, 'zh', zh), lastRunLabel(last, now, 'zh', zh)]).toEqual(['19小时后', '上次 2小时前']);
    expect([nextRunLabel(last, now, 'zh', zh), nextRunLabel(null, now, 'zh', zh), lastRunLabel(null, now, 'zh', zh)]).toEqual(['到期', '—', '从未运行']);
    expect([nextRunLabel(last, now, 'en', en), lastRunLabel(null, now, 'en', en)]).toEqual(['due', 'never run']);
  });
});

describe('execution row copy', () => {
  it('falls back to the short session id, in the UI language', () => {
    expect(execSummary(exec({ sessionId: 's-1' }), zh)).toBe('会话 s-1');
    expect(execSummary(exec({ sessionId: 'abcdef12-3456-7890-abcd-ef1234567890' }), en)).toBe('session abcdef12');
    expect(execSummary(exec({}), zh)).toBe('本地执行');
  });
});

const session = (p: Partial<SessionInfo>): SessionInfo => ({
  sessionId: 'sess',
  projectId: 'proj',
  label: null,
  origin: 'direct',
  teamLeadId: null,
  running: false,
  backgroundRunning: false,
  awaitingInput: false,
  waitingOn: 0,
  createdAt: '2026-07-06T00:00:00.000Z',
  lastUsedAt: '2026-07-06T00:00:00.000Z',
  ...p,
} as SessionInfo);

describe('execRows', () => {
  const now = Date.parse('2026-07-06T12:00:00');
  const byId = new Map([
    ['lead', session({ sessionId: 'lead', label: 'Optimizer study' })],
    ['w1', session({ sessionId: 'w1', label: 'adam-sweep', teamLeadId: 'lead' })],
    ['sch', session({ sessionId: 'sch', label: 'Daily check', origin: 'scheduled' })],
  ]);

  it('names each run by its session title and tags workers and schedules', () => {
    const rows = execRows([
      exec({ id: 'e1', sessionId: 'lead', status: 'completed', durationMs: 121_000, cost: 0.33 }),
      exec({ id: 'e2', sessionId: 'w1', status: 'completed' }),
      exec({ id: 'e3', sessionId: 'sch', status: 'completed' }),
      exec({ id: 'e4', sessionId: 'abcdef12-0000', status: 'failed' }),
    ], byId, now, 'en', en);
    expect(rows.map((r) => r.title)).toEqual(['Optimizer study', 'adam-sweep', 'Daily check', 'session abcdef12']);
    expect(rows.map((r) => r.tag)).toEqual([null, en.ovTagWorker, en.wbSchedGroup, null]);
    expect(rows[0]).toMatchObject({ duration: 121_000, cost: '$0.33', statusWord: 'done' });
  });

  it('marks done, failed, scheduled, running and stopped runs', () => {
    const rows = execRows([
      exec({ sessionId: 'lead', status: 'completed' }),
      exec({ sessionId: 'sch', status: 'completed' }),
      exec({ sessionId: 'sch', status: 'failed' }),
      exec({ sessionId: 'lead', status: 'running' }),
      exec({ sessionId: 'lead', status: 'cancelled' }),
    ], byId, now, 'en', en);
    expect(rows.map((r) => r.mark)).toEqual(['done', 'scheduled', 'failed', 'running', 'stopped']);
  });
});

describe('clockOrDayLabel', () => {
  const now = Date.parse('2026-07-06T18:00:00');
  it('shows the clock today and the day otherwise', () => {
    expect(clockOrDayLabel('2026-07-06T16:31:00', now, 'en')).toBe('16:31');
    expect(clockOrDayLabel('2026-07-05T16:31:00', now, 'zh')).toBe('昨天');
    expect(clockOrDayLabel('2026-06-24T09:00:00', now, 'en')).toBe('Jun 24');
    expect(clockOrDayLabel('', now, 'en')).toBe('—');
  });
});

describe('groupSessions', () => {
  it('splits blocked-on-you from running and waiting, and leaves idle sessions out', () => {
    const groups = groupSessions([
      session({ sessionId: 'idle', label: 'Idle' }),
      session({ sessionId: 'wait', label: 'Waits', waitingOn: 2, lastUsedAt: '2026-07-06T03:00:00.000Z' }),
      session({ sessionId: 'ask', label: 'Asks', awaitingInput: true, running: true }),
      session({ sessionId: 'run', label: 'Runs', running: true, lastUsedAt: '2026-07-06T01:00:00.000Z',
        todos: { items: [], total: 5, completed: 3, activeLabel: 'Running seed 4/5', updatedAt: 0 } }),
      session({ sessionId: 'bg', label: 'Background', running: true, backgroundRunning: true, lastUsedAt: '2026-07-06T02:00:00.000Z' }),
    ], en);
    expect(groups.needsYou.map((r) => r.sessionId)).toEqual(['ask']);
    expect(groups.inProgress.map((r) => r.sessionId)).toEqual(['bg', 'run', 'wait']);
    expect(groups.inProgress.map((r) => r.doing)).toEqual([en.pillBackground, 'Running seed 4/5', 'Waiting on 2 signals']);
  });

  it('never puts a worker in Needs you — its questions go to its lead', () => {
    const groups = groupSessions([
      session({ sessionId: 'w', teamLeadId: 'lead', awaitingInput: true, running: true }),
    ], zh);
    expect(groups.needsYou).toEqual([]);
    expect(groups.inProgress.map((r) => r.state)).toEqual(['running']);
  });

  it('lists a session once even when both origins return it', () => {
    const s = session({ sessionId: 'dup', running: true });
    expect(groupSessions([s, s], en).inProgress).toHaveLength(1);
  });

  it('says how many signals a waiting session waits on', () => {
    const [row] = groupSessions([session({ waitingOn: 1 })], zh).inProgress;
    expect(row.doing).toBe('等待 1 个信号');
  });
});

describe('needsYouReason', () => {
  const now = Date.parse('2026-07-06T12:12:00Z');
  it('joins the question and the age, dropping what is unknown', () => {
    const at = Date.parse('2026-07-06T12:00:00Z');
    expect(needsYouReason('Asks: 500 or 1000 steps?', at, now, 'en')).toBe('Asks: 500 or 1000 steps? · 12m ago');
    expect(needsYouReason(undefined, at, now, 'zh')).toBe('12分钟前');
    expect(needsYouReason(undefined, 0, now, 'en')).toBe('');
  });
});

describe('pendingDecisionRows', () => {
  const board = (id: string, title: string) => ({ id, title, projectId: 'proj', slug: id } as BoardInfo);
  const decision = (ts: string, actions: BoardDecisionEntry['item']['actions'] = []): BoardDecisionEntry => ({
    ts,
    sessionId: 'lead',
    item: { id: ts, title: 't', decision: 'd', context: '', reasoning: '', actions },
  });

  it('counts unanswered decisions per board, newest board first', () => {
    const rows = pendingDecisionRows([board('a', 'Alpha'), board('b', 'Beta'), board('c', 'Gamma')], [
      [decision('2026-07-06T10:00:00Z'), decision('2026-07-06T11:00:00Z', [{ action: 'approve', ts: '2026-07-06T11:05:00Z' }])],
      [decision('2026-07-06T09:00:00Z'), decision('2026-07-06T12:00:00Z'), decision('2026-07-06T08:00:00Z', [{ action: 'explain', ts: 'x' }])],
      undefined,
    ]);
    expect(rows).toEqual([
      { boardId: 'b', boardTitle: 'Beta', pending: 2, latestTs: '2026-07-06T12:00:00Z' },
      { boardId: 'a', boardTitle: 'Alpha', pending: 1, latestTs: '2026-07-06T10:00:00Z' },
    ]);
  });
});

describe('recentMemoryFiles', () => {
  it('takes the most recently modified files across the top level and memory dirs', () => {
    const facts = deriveMemoryTreeFacts({
      projectId: 'proj',
      files: [
        { name: 'STATUS.md', sizeBytes: 1, modifiedAt: '2026-07-01T00:00:00Z' },
        { name: 'mission.md', sizeBytes: 1, modifiedAt: '2026-07-05T00:00:00Z' },
      ],
      dirs: [{
        name: 'experiments',
        entryCount: 2,
        entries: [
          { name: 'EXP-003.md', sizeBytes: 1, modifiedAt: '2026-07-06T00:00:00Z' },
          { name: 'EXP-001.md', sizeBytes: 1, modifiedAt: '2026-06-01T00:00:00Z' },
        ],
      }],
    });
    expect(recentMemoryFiles(facts, 2)).toEqual([
      { path: 'experiments/EXP-003.md', name: 'EXP-003.md', modifiedAt: '2026-07-06T00:00:00Z' },
      { path: 'mission.md', name: 'mission.md', modifiedAt: '2026-07-05T00:00:00Z' },
    ]);
    expect(recentMemoryFiles(deriveMemoryTreeFacts(undefined))).toEqual([]);
  });
});

describe('spend helpers', () => {
  it('names the known triggers and keeps their colour whatever the ranking', () => {
    expect([triggerLabel('user', zh), triggerLabel('scheduled', en), triggerLabel('hook:onNew', en)])
      .toEqual(['对话', en.wbSchedGroup, 'hook:onNew']);
    const rows = [
      { label: 'scheduled', cost: 3, pct: 50 },
      { label: 'subagent', cost: 2, pct: 30 },
      { label: 'user', cost: 1, pct: 10 },
      { label: 'edit-retry', cost: 1, pct: 10 },
    ];
    expect(triggerSlots(rows, 4)).toEqual([1, 2, 0, 3]);
  });
  it('flags a forecast past the daily budget only when there is a budget', () => {
    expect(forecastOverBudget(12, 10)).toBe(true);
    expect(forecastOverBudget(8, 10)).toBe(false);
    expect(forecastOverBudget(12, 0)).toBe(false);
  });
  it('labels a series day in local time', () => {
    const now = Date.parse('2026-10-18T12:00:00');
    expect(seriesDayLabel('2026-10-05', now, 'zh')).toBe('10月5日');
    expect(seriesDayLabel('2026-10-05', now, 'en')).toBe('Oct 5');
  });
});
