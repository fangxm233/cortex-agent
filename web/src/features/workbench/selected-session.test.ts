// input:  vitest, selected-session helpers, SessionInfo DTO
// output: selection, transition and shortcut regressions
// pos:    Pure tests for workbench session-selection state
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import {
  deriveMostRecentSessionId,
  resolveSelectedSessionId,
  resolveTransitionProfile,
  isNewSessionShortcut,
  type PendingCreatedSession,
} from './selected-session';

function sess(id: string, lastUsedAt: string, projectId = 'p1'): SessionInfo {
  return {
    sessionId: id, backendSessionId: null, name: id, projectId, backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: lastUsedAt, lastUsedAt, resumable: true, label: null, profileName: null, running: false, backgroundRunning: false, awaitingInput: false, numTurns: null, costUsd: null, unread: false, scheduleId: null,
  };
}

const sessions = [
  sess('a', '2026-05-01T00:00:00Z'),
  sess('b', '2026-05-10T00:00:00Z'),
  sess('c', '2026-05-05T00:00:00Z'),
];

describe('isNewSessionShortcut', () => {
  it('reserves command/control-shift-N for the notes drawer', () => {
    expect(isNewSessionShortcut({ key: 'n', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(true);
    expect(isNewSessionShortcut({ key: 'N', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe(false);
  });
});

describe('deriveMostRecentSessionId', () => {
  it('picks the most-recently-used session', () => {
    expect(deriveMostRecentSessionId(sessions)).toBe('b');
  });
  it('returns null for an empty list', () => {
    expect(deriveMostRecentSessionId([])).toBeNull();
  });
});

describe('resolveSelectedSessionId', () => {
  it('honors an override that is still in the list', () => {
    expect(resolveSelectedSessionId('a', sessions)).toBe('a');
  });
  it('falls back to most-recent when the override left the list (e.g. after a project switch)', () => {
    expect(resolveSelectedSessionId('x', sessions)).toBe('b');
  });
  it('falls back to most-recent when there is no override', () => {
    expect(resolveSelectedSessionId(null, sessions)).toBe('b');
  });
  it('keeps a just-created override selected before its row lands in the list (no flip to previous)', () => {
    // The new session id is the override but not yet in the (still refetching) list.
    expect(resolveSelectedSessionId('new', sessions, 'new')).toBe('new');
  });
  it('a pending id only forces selection while it equals the override', () => {
    expect(resolveSelectedSessionId('a', sessions, 'new')).toBe('a');
  });
  it('DRAFT_SENTINEL still passes through even with a pending id', () => {
    expect(resolveSelectedSessionId('__draft__', sessions, 'new')).toBe('__draft__');
  });
});

describe('resolveTransitionProfile', () => {
  const pending: PendingCreatedSession = { sessionId: 'new', profileName: 'sol' };

  it('keeps the chosen draft profile while the new session row is still absent', () => {
    expect(resolveTransitionProfile(null, pending, 'new')).toBe('sol');
  });

  it('prefers the authoritative session-list profile once it arrives', () => {
    expect(resolveTransitionProfile('execute', pending, 'new')).toBe('execute');
  });

  it('never leaks pending profile metadata into a different session', () => {
    expect(resolveTransitionProfile(null, pending, 'other')).toBeNull();
  });
});

describe('resolveSelectedSessionId with scheduled runs in the membership list (27a-B)', () => {
  const run = (id: string, lastUsedAt: string): SessionInfo => ({
    ...sess(id, lastUsedAt),
    kind: 'scheduled', origin: 'scheduled', scheduleId: 'sch1',
  });

  it('honors an override pointing at a scheduled run (clicking a run row keeps it selected)', () => {
    const merged = [...sessions, run('r1', '2026-05-20T00:00:00Z')];
    expect(resolveSelectedSessionId('r1', merged)).toBe('r1');
  });

  it('default selection comes from the defaultPool, never auto-opening the newest run', () => {
    const merged = [...sessions, run('r1', '2026-05-20T00:00:00Z')];
    expect(resolveSelectedSessionId(null, merged, null, sessions)).toBe('b');
    expect(resolveSelectedSessionId('gone', merged, null, sessions)).toBe('b');
  });
});
