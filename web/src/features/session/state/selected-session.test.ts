import { describe, expect, it } from 'vitest';
import type { EngineSelection, SessionInfo } from '@cortex-agent/ui-contract';
import {
  applyDraftSelection, clearDraftClean, deriveMostRecentSessionId, DRAFT_SENTINEL, EMPTY_DRAFT_SELECTION,
  resolveSelectedSessionId, resolveTransitionAgent, resolveTransitionClean, resolveTransitionSelection,
  seedDraftSelection,
  type PendingCreatedSession,
} from './selected-session';

const claude: EngineSelection = { backend: 'claude', provider: null, model: 'claude-opus-5', thinking: 'high', mode: 'plan' };
const pi: EngineSelection = { backend: 'pi', provider: 'deepseek', model: 'deepseek-v4-flash', thinking: null, mode: 'deepseek' };

function sess(id: string, lastUsedAt: string, projectId = 'p1'): SessionInfo {
  return {
    sessionId: id, backendSessionId: null, projectId, backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: lastUsedAt, lastUsedAt, resumable: true, label: null, selection: null,
    running: false, backgroundRunning: false, awaitingInput: false, numTurns: null, costUsd: null,
    unread: false, scheduleId: null, boardId: null, teamLeadId: null, workerName: null,
  };
}
const sessions = [sess('a', '2026-05-01T00:00:00Z'), sess('b', '2026-05-10T00:00:00Z'), sess('c', '2026-05-05T00:00:00Z')];
const pending: PendingCreatedSession = { sessionId: 'new', selection: pi, agentName: 'research' };

describe('session identity', () => {
  it('derives the most recently used session without reordering the input', () => {
    expect(deriveMostRecentSessionId(sessions)).toBe('b');
    expect(sessions.map((session) => session.sessionId)).toEqual(['a', 'b', 'c']);
    expect(deriveMostRecentSessionId([])).toBeNull();
  });

  it('falls back to createdAt when lastUsedAt is absent', () => {
    const newest = { ...sess('newest', '2026-06-01T00:00:00Z'), lastUsedAt: '' };
    expect(deriveMostRecentSessionId([...sessions, newest])).toBe('newest');
  });

  it('honors valid explicit selection, otherwise derives from the current list', () => {
    expect(resolveSelectedSessionId('a', sessions)).toBe('a');
    expect(resolveSelectedSessionId('gone', sessions)).toBe('b');
    expect(resolveSelectedSessionId(null, sessions)).toBe('b');
    expect(resolveSelectedSessionId(null, [])).toBeNull();
  });

  it('keeps the just-created session selected across the list refetch gap', () => {
    expect(resolveSelectedSessionId('new', sessions, 'new')).toBe('new');
    expect(resolveSelectedSessionId('a', sessions, 'new')).toBe('a');
    expect(resolveSelectedSessionId('gone', sessions, 'new')).toBe('b');
    expect(resolveSelectedSessionId(DRAFT_SENTINEL, sessions, 'new')).toBe(DRAFT_SENTINEL);
  });

  it('allows explicit scheduled runs but never derives one from the membership list', () => {
    const run: SessionInfo = { ...sess('run', '2026-05-20T00:00:00Z'), kind: 'scheduled', origin: 'scheduled', scheduleId: 'sch1' };
    const merged = [...sessions, run];
    expect(resolveSelectedSessionId('run', merged, null, sessions)).toBe('run');
    expect(resolveSelectedSessionId(null, merged, null, sessions)).toBe('b');
    expect(resolveSelectedSessionId('gone', merged, null, sessions)).toBe('b');
    expect(resolveSelectedSessionId(null, [run], null, [])).toBeNull();
  });
});

describe('resolveTransitionSelection', () => {
  it('retains all draft engine fields only until the matching row arrives', () => {
    expect(resolveTransitionSelection(undefined, pending, 'new')).toEqual(pi);
    expect(resolveTransitionSelection(claude, pending, 'new')).toEqual(claude);
  });

  it('treats explicit row null as authoritative, not as a missing row', () => {
    expect(resolveTransitionSelection(null, pending, 'new')).toBeNull();
  });

  it('never leaks pending selection into a different or absent session', () => {
    expect(resolveTransitionSelection(undefined, pending, 'other')).toBeNull();
    expect(resolveTransitionSelection(undefined, pending, null)).toBeNull();
    expect(resolveTransitionSelection(undefined, null, 'new')).toBeNull();
    expect(resolveTransitionSelection(claude, pending, 'other')).toEqual(claude);
  });

  it('preserves null pending selections and explicit null thinking', () => {
    expect(resolveTransitionSelection(undefined, { ...pending, selection: null }, 'new')).toBeNull();
    expect(resolveTransitionSelection(pi, pending, 'new')).toEqual(pi);
  });
});

describe('resolveTransitionAgent', () => {
  it('retains the pending environment while its matching row is absent', () => {
    expect(resolveTransitionAgent(undefined, pending, 'new')).toBe('research');
    expect(resolveTransitionAgent(undefined, { ...pending, agentName: null }, 'new')).toBeNull();
  });

  it('prefers the authoritative environment, including an explicit default', () => {
    expect(resolveTransitionAgent('main', pending, 'new')).toBe('main');
    expect(resolveTransitionAgent(null, pending, 'new')).toBeNull();
  });

  it('never leaks the pending environment to another session', () => {
    expect(resolveTransitionAgent(undefined, pending, 'other')).toBeNull();
    expect(resolveTransitionAgent(undefined, pending, null)).toBeNull();
    expect(resolveTransitionAgent(undefined, null, 'new')).toBeNull();
  });
});

describe('clean mode', () => {
  it('toggles on a draft and is dropped when the draft is left', () => {
    const on = applyDraftSelection({ selection: pi, agentName: 'research' }, { clean: true });
    expect(on).toEqual({ selection: pi, agentName: 'research', clean: true });
    expect(clearDraftClean(on)).toEqual({ selection: pi, agentName: 'research' });
    const off = { selection: pi };
    expect(clearDraftClean(off)).toBe(off);
  });

  it('is never seeded from the remembered selection', () => {
    expect(seedDraftSelection({ ...pi, agentName: 'research' }, claude)).not.toHaveProperty('clean');
  });

  it('follows the created draft until the row lands, then the row', () => {
    const created = { ...pending, clean: true };
    expect(resolveTransitionClean(undefined, created, 'new')).toBe(true);
    expect(resolveTransitionClean(false, created, 'new')).toBe(false);
    expect(resolveTransitionClean(true, null, 'new')).toBe(true);
    expect(resolveTransitionClean(undefined, created, 'other')).toBe(false);
    expect(resolveTransitionClean(undefined, pending, 'new')).toBe(false);
  });
});

describe('applyDraftSelection', () => {
  it('replaces a full engine selection without inheriting fields from the previous backend', () => {
    const draft = { selection: claude, agentName: 'research' };
    expect(applyDraftSelection(draft, { selection: pi })).toEqual({ selection: pi, agentName: 'research' });
    expect(draft).toEqual({ selection: claude, agentName: 'research' });
  });

  it('changes the environment without touching the engine', () => {
    expect(applyDraftSelection({ selection: pi }, { agentName: 'research' }))
      .toEqual({ selection: pi, agentName: 'research' });
    expect(applyDraftSelection({ selection: pi, agentName: 'research' }, { agentName: null }))
      .toEqual({ selection: pi, agentName: null });
  });

  it('accepts both independent axes together and preserves an untouched empty draft', () => {
    expect(applyDraftSelection(EMPTY_DRAFT_SELECTION, { selection: pi, agentName: 'research' }))
      .toEqual({ selection: pi, agentName: 'research' });
    expect(applyDraftSelection(EMPTY_DRAFT_SELECTION, {})).toEqual({ selection: null });
    expect(EMPTY_DRAFT_SELECTION).toEqual({ selection: null });
  });
});

describe('seedDraftSelection', () => {
  it('uses the remembered engine and environment instead of the configured default', () => {
    const seed = { ...pi, agentName: 'research' };
    const draft = seedDraftSelection(seed, claude);
    expect(draft).toEqual({ selection: pi, agentName: 'research' });
    expect(draft?.selection).not.toBe(seed);
    expect(draft?.selection).not.toHaveProperty('agentName');
  });

  it('keeps the complete remembered selection even without a configured default', () => {
    expect(seedDraftSelection(pi, null)).toEqual({ selection: pi });
  });

  it.each([null, undefined])('falls back to the configured full default when memory is %s', (seed) => {
    expect(seedDraftSelection(seed, claude)).toEqual({ selection: claude });
  });

  it('does not manufacture an engine or environment when neither source is configured', () => {
    expect(seedDraftSelection(null, null)).toBeNull();
    expect(seedDraftSelection(undefined, null)).toBeNull();
  });
});
