import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { en } from '@/i18n';
import { groupSessions, groupRailItems, sessionMeta, sessionStamp, scheduleTitle, projectInitials } from './session-groups';

function mk(p: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  const created = p.createdAt ?? '2026-07-06T00:00:00.000Z';
  return {
    sessionId: p.sessionId,
    backendSessionId: p.backendSessionId ?? null,
    name: p.name ?? p.sessionId,
    projectId: p.projectId ?? 'proj',
    backend: p.backend ?? 'claude',
    kind: p.kind ?? 'local',
    origin: p.origin ?? 'direct',
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
    scheduleId: p.scheduleId ?? null,
  };
}

function run(p: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  return mk({ kind: 'scheduled', origin: 'scheduled', scheduleId: 'sch1', ...p });
}

// Local wall-clock anchors (constructed from components so the test is timezone-agnostic —
// grouping + meta both use the machine's local calendar day / clock).
const now = new Date(2026, 6, 6, 15, 0, 0); // Mon Jul 6 2026 15:00 local
const todayMorning = new Date(2026, 6, 6, 7, 5, 0);
const todayLate = new Date(2026, 6, 6, 11, 20, 0);
const yesterday = new Date(2026, 6, 5, 21, 38, 0);
const older = new Date(2026, 6, 1, 12, 0, 0);

describe('groupSessions', () => {
  it('partitions into TODAY / YESTERDAY / EARLIER by local calendar day', () => {
    const sessions = [
      mk({ sessionId: 'a', lastUsedAt: older.toISOString() }),
      mk({ sessionId: 'b', lastUsedAt: yesterday.toISOString() }),
      mk({ sessionId: 'c', lastUsedAt: todayMorning.toISOString() }),
    ];
    const groups = groupSessions(sessions, now);
    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY', 'EARLIER']);
    expect(groups[0].items.map((s) => s.sessionId)).toEqual(['c']);
    expect(groups[1].items.map((s) => s.sessionId)).toEqual(['b']);
    expect(groups[2].items.map((s) => s.sessionId)).toEqual(['a']);
  });

  it('omits empty groups and preserves TODAY/YESTERDAY/EARLIER order', () => {
    const sessions = [mk({ sessionId: 'c', lastUsedAt: todayMorning.toISOString() })];
    const groups = groupSessions(sessions, now);
    expect(groups.map((g) => g.label)).toEqual(['TODAY']);
  });

  it('sorts items within a group most-recent first', () => {
    const sessions = [
      mk({ sessionId: 'early', lastUsedAt: todayMorning.toISOString() }),
      mk({ sessionId: 'late', lastUsedAt: todayLate.toISOString() }),
    ];
    const groups = groupSessions(sessions, now);
    expect(groups[0].items.map((s) => s.sessionId)).toEqual(['late', 'early']);
  });

  it('falls back to createdAt when lastUsedAt is empty', () => {
    const s = mk({ sessionId: 'x', createdAt: todayMorning.toISOString(), lastUsedAt: '' });
    const groups = groupSessions([s], now);
    expect(groups[0].label).toBe('TODAY');
  });

  it('returns no groups for an empty list', () => {
    expect(groupSessions([], now)).toEqual([]);
  });
});

describe('sessionMeta', () => {
  it('renders HH:MM of the effective timestamp (local) for TODAY / YESTERDAY rows', () => {
    expect(sessionMeta(en, mk({ sessionId: 'a', lastUsedAt: todayMorning.toISOString() }), now)).toBe('07:05');
    expect(sessionMeta(en, mk({ sessionId: 'b', lastUsedAt: yesterday.toISOString() }), now)).toBe('21:38');
  });

  it('prefixes MM-DD for EARLIER rows, whose group header carries no date', () => {
    expect(sessionMeta(en, mk({ sessionId: 'c', lastUsedAt: older.toISOString() }), now)).toBe('07-01 12:00');
  });

  it('widens to YYYY-MM-DD once the year differs from the current one', () => {
    const lastYear = new Date(2025, 11, 24, 9, 7, 0);
    expect(sessionMeta(en, mk({ sessionId: 'd', lastUsedAt: lastYear.toISOString() }), now)).toBe('2025-12-24 09:07');
  });

  it('appends "· from schedule" for scheduled sessions', () => {
    const s = mk({ sessionId: 's', kind: 'scheduled', lastUsedAt: new Date(2026, 6, 6, 7, 31).toISOString() });
    expect(sessionMeta(en, s, now)).toBe('07:31 · from schedule');
    const old = mk({ sessionId: 't', kind: 'scheduled', lastUsedAt: older.toISOString() });
    expect(sessionMeta(en, old, now)).toBe('07-01 12:00 · from schedule');
  });

  it('defaults now to the current clock', () => {
    const justNow = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    expect(sessionMeta(en, mk({ sessionId: 'n', lastUsedAt: justNow.toISOString() })))
      .toBe(`${pad(justNow.getHours())}:${pad(justNow.getMinutes())}`);
  });
});

describe('projectInitials', () => {
  it('takes the first letter of the first two hyphen segments, uppercased', () => {
    expect(projectInitials('quad-nav-sim2real')).toBe('QN');
    expect(projectInitials('cortex-self')).toBe('CS');
  });

  it('uses the first two chars for a single-segment id', () => {
    expect(projectInitials('nimbus')).toBe('NI');
  });

  it('handles empty / degenerate ids', () => {
    expect(projectInitials('')).toBe('?');
  });
});

describe('groupSessions unread ordering', () => {
  it('floats unread sessions to the top of their group, keeping recency order within each half', () => {
    const now = new Date('2026-07-06T12:00:00.000Z');
    const groups = groupSessions(
      [
        mk({ sessionId: 'read-new', lastUsedAt: '2026-07-06T11:00:00.000Z' }),
        mk({ sessionId: 'unread-old', lastUsedAt: '2026-07-06T08:00:00.000Z', unread: true }),
        mk({ sessionId: 'unread-new', lastUsedAt: '2026-07-06T10:00:00.000Z', unread: true }),
        mk({ sessionId: 'read-old', lastUsedAt: '2026-07-06T07:00:00.000Z' }),
      ],
      now,
    );
    expect(groups[0].label).toBe('TODAY');
    expect(groups[0].items.map((s) => s.sessionId)).toEqual([
      'unread-new', 'unread-old', 'read-new', 'read-old',
    ]);
  });

  it('unread ordering stays inside each day group (no cross-group hoisting)', () => {
    const now = new Date('2026-07-06T12:00:00.000Z');
    const groups = groupSessions(
      [
        mk({ sessionId: 'today-read', lastUsedAt: '2026-07-06T09:00:00.000Z' }),
        mk({ sessionId: 'yesterday-unread', lastUsedAt: '2026-07-05T09:00:00.000Z', unread: true }),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY']);
    expect(groups[0].items[0].sessionId).toBe('today-read');
    expect(groups[1].items[0].sessionId).toBe('yesterday-unread');
  });
});

// ── groupRailItems (design 27a-B: schedule runs share the manual timeline) ──

describe('groupRailItems', () => {
  it('collapses ≥2 runs of one schedule into a group row in the shared timeline, latest run first', () => {
    const groups = groupRailItems(
      [
        mk({ sessionId: 'manual', lastUsedAt: todayLate.toISOString() }),
        run({ sessionId: 'r1', lastUsedAt: todayMorning.toISOString() }),
        run({ sessionId: 'r2', lastUsedAt: new Date(2026, 6, 6, 12, 30).toISOString() }),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['TODAY']);
    expect(groups[0].items.map((i) => i.kind)).toEqual(['schedule-group', 'session']);
    const grp = groups[0].items[0];
    if (grp.kind !== 'schedule-group') throw new Error('expected schedule-group');
    expect(grp.scheduleId).toBe('sch1');
    expect(grp.runs.map((r) => r.sessionId)).toEqual(['r2', 'r1']);
    expect(grp.latest.sessionId).toBe('r2');
  });

  it('keeps a single run as a plain session row (no group of one)', () => {
    const groups = groupRailItems([run({ sessionId: 'solo', lastUsedAt: todayMorning.toISOString() })], now);
    expect(groups[0].items).toEqual([expect.objectContaining({ kind: 'session' })]);
  });

  it('never groups legacy runs without a scheduleId', () => {
    const groups = groupRailItems(
      [
        run({ sessionId: 'l1', scheduleId: null, lastUsedAt: todayMorning.toISOString() }),
        run({ sessionId: 'l2', scheduleId: null, lastUsedAt: todayLate.toISOString() }),
      ],
      now,
    );
    expect(groups[0].items.map((i) => i.kind)).toEqual(['session', 'session']);
  });

  it('does not group an adopted run (origin direct) — it left the schedule grouping', () => {
    const groups = groupRailItems(
      [
        run({ sessionId: 'r1', lastUsedAt: todayMorning.toISOString() }),
        run({ sessionId: 'adopted', kind: 'local', origin: 'direct', lastUsedAt: todayLate.toISOString() }),
      ],
      now,
    );
    expect(groups[0].items.map((i) => i.kind)).toEqual(['session', 'session']);
  });

  it('buckets and sorts the group by its LATEST run; older runs do not echo into other days', () => {
    const groups = groupRailItems(
      [
        mk({ sessionId: 'y-manual', lastUsedAt: yesterday.toISOString() }),
        run({ sessionId: 'r-old', lastUsedAt: older.toISOString() }),
        run({ sessionId: 'r-new', lastUsedAt: todayMorning.toISOString() }),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY']);
    expect(groups[0].items[0].kind).toBe('schedule-group');
    expect(groups[1].items.map((i) => i.kind)).toEqual(['session']);
  });

  it('aggregates unread across runs and floats the group like an unread session', () => {
    const groups = groupRailItems(
      [
        mk({ sessionId: 'manual', lastUsedAt: todayLate.toISOString() }),
        run({ sessionId: 'r1', lastUsedAt: todayMorning.toISOString(), unread: true }),
        run({ sessionId: 'r2', lastUsedAt: new Date(2026, 6, 6, 8, 0).toISOString() }),
      ],
      now,
    );
    const grp = groups[0].items[0];
    if (grp.kind !== 'schedule-group') throw new Error('expected the unread group to float first');
    expect(grp.unread).toBe(true);
  });

  it('groups different schedules separately', () => {
    const groups = groupRailItems(
      [
        run({ sessionId: 'a1', lastUsedAt: todayMorning.toISOString() }),
        run({ sessionId: 'a2', lastUsedAt: todayLate.toISOString() }),
        run({ sessionId: 'b1', scheduleId: 'sch2', lastUsedAt: yesterday.toISOString() }),
        run({ sessionId: 'b2', scheduleId: 'sch2', lastUsedAt: older.toISOString() }),
      ],
      now,
    );
    const kinds = groups.flatMap((g) => g.items.map((i) => (i.kind === 'schedule-group' ? i.scheduleId : 'session')));
    expect(kinds).toEqual(['sch1', 'sch2']);
    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY']);
  });
});

describe('sessionStamp / scheduleTitle', () => {
  it('sessionStamp is the raw time stamp — no "from schedule" suffix even for runs', () => {
    expect(sessionStamp(run({ sessionId: 's', lastUsedAt: new Date(2026, 6, 6, 7, 31).toISOString() }), now)).toBe('07:31');
    expect(sessionStamp(run({ sessionId: 't', lastUsedAt: older.toISOString() }), now)).toBe('07-01 12:00');
  });

  it('scheduleTitle prefers the schedule message, then run label, then session name', () => {
    const latest = run({ sessionId: 'r', label: 'run label', name: 'cortex-9' });
    expect(scheduleTitle('scan arXiv', latest)).toBe('scan arXiv');
    expect(scheduleTitle(undefined, latest)).toBe('run label');
    expect(scheduleTitle('  ', run({ sessionId: 'r2', label: null, name: 'cortex-9' }))).toBe('cortex-9');
  });
});
