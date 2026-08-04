import { describe, it, expect } from 'vitest';
import type { ScheduleInfo, SessionInfo } from '@cortex-agent/ui-contract';
import {
  buildScheduleRows,
  runOrdinals,
  scheduledRunTitle,
  scheduleRowAction,
  scheduleSubline,
  unreadScheduleCount,
} from './schedule-rail';

function mkRun(p: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  const created = p.createdAt ?? '2026-07-06T07:30:00.000Z';
  return {
    sessionId: p.sessionId,
    backendSessionId: p.backendSessionId ?? null,
    name: p.name ?? p.sessionId,
    projectId: p.projectId ?? 'proj',
    backend: p.backend ?? 'claude',
    kind: p.kind ?? 'scheduled',
    origin: p.origin ?? 'scheduled',
    scheduleId: 'scheduleId' in p ? (p.scheduleId ?? null) : 'sch1',
    createdAt: created,
    lastUsedAt: p.lastUsedAt ?? created,
    resumable: p.resumable ?? true,
    label: p.label ?? null,
    profileName: p.profileName ?? null,
    running: p.running ?? false,
    backgroundRunning: p.backgroundRunning ?? false,
    awaitingInput: p.awaitingInput ?? false,
    numTurns: p.numTurns ?? null,
    costUsd: p.costUsd ?? null,
    unread: p.unread ?? false,
  };
}

function mkSched(p: Partial<ScheduleInfo> & { id: string }): ScheduleInfo {
  return {
    id: p.id,
    type: p.type ?? 'daily',
    message: p.message ?? 'scan arXiv',
    projectId: p.projectId ?? 'proj',
    profile: p.profile ?? null,
    nextRun: p.nextRun ?? null,
    lastRun: p.lastRun ?? null,
    paused: p.paused ?? false,
    pausedBy: p.pausedBy ?? null,
    intervalMs: p.intervalMs ?? null,
    time: p.time ?? '07:30',
    dayOfWeek: p.dayOfWeek ?? null,
    target: p.target ?? null,
    fallback: p.fallback ?? null,
  };
}

const now = new Date(2026, 6, 6, 15, 0, 0).getTime(); // local Mon Jul 6 2026 15:00

describe('buildScheduleRows', () => {
  it('one row per live schedule with its runs sorted latest-first', () => {
    const rows = buildScheduleRows(
      [mkSched({ id: 'sch1' })],
      [
        mkRun({ sessionId: 'r1', createdAt: '2026-07-05T07:30:00.000Z' }),
        mkRun({ sessionId: 'r2', createdAt: '2026-07-06T07:30:00.000Z' }),
      ],
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduleId).toBe('sch1');
    expect(rows[0].kind).toBe('repeat');
    expect(rows[0].title).toBe('scan arXiv');
    expect(rows[0].runs.map((r) => r.sessionId)).toEqual(['r2', 'r1']);
    expect(rows[0].latest?.sessionId).toBe('r2');
  });

  it('keeps a live schedule visible with zero runs (never fired / runs purged)', () => {
    const rows = buildScheduleRows([mkSched({ id: 'schN', message: 'env check' })], [], now);
    expect(rows).toHaveLength(1);
    expect(rows[0].runs).toEqual([]);
    expect(rows[0].latest).toBeNull();
    expect(rows[0].title).toBe('env check');
  });

  it('a fired once schedule (record deleted) surfaces as an orphan once row titled by its run', () => {
    const rows = buildScheduleRows(
      [],
      [mkRun({ sessionId: 'o1', scheduleId: 'gone', label: 'EXP summary' })],
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toBeNull();
    expect(rows[0].kind).toBe('once');
    expect(rows[0].title).toBe('EXP summary');
  });

  it('an orphan group with ≥2 runs stays a repeat row (deleted repeating schedule)', () => {
    const rows = buildScheduleRows(
      [],
      [
        mkRun({ sessionId: 'o1', scheduleId: 'gone', createdAt: '2026-07-05T07:30:00.000Z' }),
        mkRun({ sessionId: 'o2', scheduleId: 'gone', createdAt: '2026-07-06T07:30:00.000Z' }),
      ],
      now,
    );
    expect(rows[0].kind).toBe('repeat');
    expect(rows[0].runs).toHaveLength(2);
  });

  it('a live once schedule not yet fired is a once row with no runs', () => {
    const rows = buildScheduleRows(
      [mkSched({ id: 'sch1', type: 'once', message: 'summarize EXP' })],
      [],
      now,
    );
    expect(rows[0].kind).toBe('once');
    expect(rows[0].runs).toEqual([]);
  });

  it('ignores scheduled sessions without a scheduleId (legacy) — they are not rows', () => {
    const rows = buildScheduleRows([], [mkRun({ sessionId: 'x', scheduleId: null })], now);
    expect(rows).toEqual([]);
  });

  it('aggregates unread across a row runs', () => {
    const rows = buildScheduleRows(
      [mkSched({ id: 'sch1' })],
      [
        mkRun({ sessionId: 'r1', unread: false }),
        mkRun({ sessionId: 'r2', createdAt: '2026-07-06T08:00:00.000Z', unread: true }),
      ],
      now,
    );
    expect(rows[0].unread).toBe(true);
  });

  it('orders rows by latest activity desc; never-fired rows sink last', () => {
    const rows = buildScheduleRows(
      [mkSched({ id: 'quiet', message: 'quiet' }), mkSched({ id: 'busy', message: 'busy' })],
      [
        mkRun({ sessionId: 'q1', scheduleId: 'quiet', createdAt: '2026-07-01T12:00:00.000Z' }),
        mkRun({ sessionId: 'b1', scheduleId: 'busy', createdAt: '2026-07-06T07:30:00.000Z' }),
      ],
      now,
    );
    expect(rows.map((r) => r.scheduleId)).toEqual(['busy', 'quiet']);
    const withPending = buildScheduleRows(
      [mkSched({ id: 'pending', message: 'new one' }), mkSched({ id: 'busy', message: 'busy' })],
      [mkRun({ sessionId: 'b1', scheduleId: 'busy' })],
      now,
    );
    expect(withPending.map((r) => r.scheduleId)).toEqual(['busy', 'pending']);
  });

  it('adopted runs (origin direct) do not count — they moved to the timeline', () => {
    const rows = buildScheduleRows(
      [mkSched({ id: 'sch1' })],
      [
        mkRun({ sessionId: 'kept' }),
        mkRun({ sessionId: 'adopted', origin: 'direct', kind: 'local', createdAt: '2026-07-06T09:00:00.000Z' }),
      ],
      now,
    );
    expect(rows[0].runs.map((r) => r.sessionId)).toEqual(['kept']);
  });
});

describe('runOrdinals', () => {
  it('numbers runs 1-based by createdAt ascending (oldest = #1)', () => {
    const runs = [
      mkRun({ sessionId: 'new', createdAt: '2026-07-06T07:30:00.000Z' }),
      mkRun({ sessionId: 'old', createdAt: '2026-07-04T07:30:00.000Z' }),
      mkRun({ sessionId: 'mid', createdAt: '2026-07-05T07:30:00.000Z' }),
    ];
    const ord = runOrdinals(runs);
    expect(ord.get('old')).toBe(1);
    expect(ord.get('mid')).toBe(2);
    expect(ord.get('new')).toBe(3);
  });

  it('returns an empty map for no runs', () => {
    expect(runOrdinals([]).size).toBe(0);
  });
});

describe('scheduleRowAction', () => {
  const sched = mkSched({ id: 'sch1' });
  it('repeat row with runs opens the run-list modal', () => {
    const [row] = buildScheduleRows([sched], [mkRun({ sessionId: 'r1' })], now);
    expect(scheduleRowAction(row)).toEqual({ type: 'modal' });
  });

  it('once row with a run opens that session directly (no modal)', () => {
    const [row] = buildScheduleRows(
      [],
      [mkRun({ sessionId: 'solo', scheduleId: 'gone' })],
      now,
    );
    expect(scheduleRowAction(row)).toEqual({ type: 'open', sessionId: 'solo' });
  });

  it('a live schedule with zero runs falls back to edit', () => {
    const [row] = buildScheduleRows([sched], [], now);
    expect(scheduleRowAction(row)).toEqual({ type: 'edit' });
  });
});

describe('scheduleSubline', () => {
  it('fired row → latest stamp + cost', () => {
    const [row] = buildScheduleRows(
      [mkSched({ id: 'sch1' })],
      [mkRun({ sessionId: 'r1', createdAt: new Date(2026, 6, 6, 7, 30).toISOString(), costUsd: 0.09 })],
      now,
    );
    expect(scheduleSubline(row, now)).toEqual({ kind: 'run', stamp: '07:30', cost: '$0.09' });
  });

  it('fired row without a cost keeps the stamp and omits cost (never fabricated)', () => {
    const [row] = buildScheduleRows(
      [mkSched({ id: 'sch1' })],
      [mkRun({ sessionId: 'r1', createdAt: new Date(2026, 6, 6, 7, 30).toISOString() })],
      now,
    );
    expect(scheduleSubline(row, now)).toEqual({ kind: 'run', stamp: '07:30', cost: null });
  });

  it('never-fired row → cadence + next-run delta', () => {
    const [row] = buildScheduleRows(
      [mkSched({ id: 'sch1', nextRun: new Date(now + 2 * 3600_000).toISOString() })],
      [],
      now,
    );
    expect(scheduleSubline(row, now)).toEqual({ kind: 'pending', cadence: 'daily 07:30', nextDelta: '2h' });
  });

  it('paused schedule wins over run info', () => {
    const [row] = buildScheduleRows(
      [mkSched({ id: 'sch1', paused: true })],
      [mkRun({ sessionId: 'r1' })],
      now,
    );
    expect(scheduleSubline(row, now)).toEqual({ kind: 'paused', cadence: 'daily 07:30' });
  });
});

describe('scheduledRunTitle', () => {
  const sched = mkSched({ id: 'sch1', message: 'scan arXiv' });
  const runs = [
    mkRun({ sessionId: 'r1', createdAt: '2026-07-04T07:30:00.000Z' }),
    mkRun({ sessionId: 'r2', createdAt: '2026-07-05T07:30:00.000Z' }),
  ];

  it('annotates an un-adopted run as "message · run #n"', () => {
    expect(scheduledRunTitle(sched, runs, 'r2')).toBe('scan arXiv · run #2');
    expect(scheduledRunTitle(sched, runs, 'r1')).toBe('scan arXiv · run #1');
  });

  it('returns null when the schedule record is gone or the session is not among the runs', () => {
    expect(scheduledRunTitle(null, runs, 'r2')).toBeNull();
    expect(scheduledRunTitle(sched, runs, 'other')).toBeNull();
  });
});

describe('unreadScheduleCount', () => {
  it('counts unread rows (not unread runs)', () => {
    const rows = buildScheduleRows(
      [mkSched({ id: 'a', message: 'a' }), mkSched({ id: 'b', message: 'b' })],
      [
        mkRun({ sessionId: 'a1', scheduleId: 'a', unread: true }),
        mkRun({ sessionId: 'a2', scheduleId: 'a', createdAt: '2026-07-06T08:00:00.000Z', unread: true }),
        mkRun({ sessionId: 'b1', scheduleId: 'b' }),
      ],
      now,
    );
    expect(unreadScheduleCount(rows)).toBe(1);
  });
});
