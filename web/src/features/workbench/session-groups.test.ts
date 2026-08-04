import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { en } from '@/i18n';
import { groupSessions, sessionMeta, sessionStamp, projectInitials } from './session-groups';

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

describe('sessionStamp', () => {
  it('sessionStamp is the raw time stamp — no "from schedule" suffix even for runs', () => {
    expect(sessionStamp(run({ sessionId: 's', lastUsedAt: new Date(2026, 6, 6, 7, 31).toISOString() }), now)).toBe('07:31');
    expect(sessionStamp(run({ sessionId: 't', lastUsedAt: older.toISOString() }), now)).toBe('07-01 12:00');
  });
});
