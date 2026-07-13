import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { groupSessions, sessionMeta, projectInitials } from './session-groups';

function mk(p: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  const created = p.createdAt ?? '2026-07-06T00:00:00.000Z';
  return {
    sessionId: p.sessionId,
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
  };
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
  it('renders HH:MM of the effective timestamp (local)', () => {
    expect(sessionMeta(mk({ sessionId: 'a', lastUsedAt: todayMorning.toISOString() }))).toBe('07:05');
    expect(sessionMeta(mk({ sessionId: 'b', lastUsedAt: yesterday.toISOString() }))).toBe('21:38');
  });

  it('appends "· from schedule" for scheduled sessions', () => {
    const s = mk({ sessionId: 's', kind: 'scheduled', lastUsedAt: new Date(2026, 6, 6, 7, 31).toISOString() });
    expect(sessionMeta(s)).toBe('07:31 · from schedule');
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
