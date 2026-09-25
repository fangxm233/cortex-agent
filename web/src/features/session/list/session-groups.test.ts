import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { orderSessions, projectInitials, sessionStamp } from './session-groups';

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
    commissionId: p.commissionId ?? null,
  };
}

// Local wall-clock anchors (constructed from components so the test is timezone-agnostic —
// the stamp uses the machine's local calendar day / clock).
const now = new Date(2026, 6, 6, 15, 0, 0); // Mon Jul 6 2026 15:00 local
const todayMorning = new Date(2026, 6, 6, 7, 5, 0);
const yesterday = new Date(2026, 6, 5, 21, 38, 0);
const older = new Date(2026, 6, 1, 12, 0, 0);
const lastYear = new Date(2025, 11, 30, 9, 4, 0);

describe('sessionStamp', () => {
  it('shows a bare clock for today and yesterday', () => {
    expect(sessionStamp(mk({ sessionId: 'a', lastUsedAt: todayMorning.toISOString() }), now)).toBe('07:05');
    expect(sessionStamp(mk({ sessionId: 'b', lastUsedAt: yesterday.toISOString() }), now)).toBe('21:38');
  });

  it('adds the date before yesterday, and the year once it differs', () => {
    expect(sessionStamp(mk({ sessionId: 'c', lastUsedAt: older.toISOString() }), now)).toBe('07-01 12:00');
    expect(sessionStamp(mk({ sessionId: 'd', lastUsedAt: lastYear.toISOString() }), now)).toBe('2025-12-30 09:04');
  });

  it('falls back to createdAt when lastUsedAt is empty', () => {
    const s = mk({ sessionId: 'x', createdAt: older.toISOString(), lastUsedAt: '' });
    expect(sessionStamp(s, now)).toBe('07-01 12:00');
  });
});

describe('projectInitials', () => {
  it('takes the first letter of the first two segments, else the first two chars', () => {
    expect(projectInitials('orchard-nav-sim')).toBe('ON');
    expect(projectInitials('grasp_lab')).toBe('GL');
    expect(projectInitials('nimbus')).toBe('NI');
    expect(projectInitials('--')).toBe('?');
  });
});

describe('orderSessions', () => {
  const NOW = Date.parse('2026-07-16T12:00:00');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('floats unread sessions first, keeping recency order within each half', () => {
    const ordered = orderSessions([
      mk({ sessionId: 'read-new', lastUsedAt: ago(1 * HOUR) }),
      mk({ sessionId: 'unread-old', lastUsedAt: ago(4 * HOUR), unread: true }),
      mk({ sessionId: 'unread-new', lastUsedAt: ago(2 * HOUR), unread: true }),
      mk({ sessionId: 'read-old', lastUsedAt: ago(5 * DAY) }),
    ]);
    expect(ordered.map((s) => s.sessionId)).toEqual(['unread-new', 'unread-old', 'read-new', 'read-old']);
  });

  it('falls back to createdAt when lastUsedAt is empty', () => {
    const ordered = orderSessions([
      mk({ sessionId: 'used', lastUsedAt: ago(2 * HOUR) }),
      mk({ sessionId: 'fresh', createdAt: ago(MIN), lastUsedAt: '' }),
    ]);
    expect(ordered.map((s) => s.sessionId)).toEqual(['fresh', 'used']);
  });
});
