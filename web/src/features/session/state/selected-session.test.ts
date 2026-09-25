import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import {
  deriveMostRecentSessionId,
  resolveSelectedSessionId,
  resolveTransitionAgent,
  resolveTransitionSelection,
  seedDraftSelection,
  applyDraftSelection,
  EMPTY_DRAFT_SELECTION,
  type PendingCreatedSession,
} from './selected-session';

function sess(id: string, lastUsedAt: string, projectId = 'p1'): SessionInfo {
  return {
    sessionId: id, backendSessionId: null, name: id, projectId, backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: lastUsedAt, lastUsedAt, resumable: true, label: null, profileName: null, running: false, backgroundRunning: false, awaitingInput: false, numTurns: null, costUsd: null, unread: false, scheduleId: null, commissionId: null,
  };
}

const sessions = [
  sess('a', '2026-05-01T00:00:00Z'),
  sess('b', '2026-05-10T00:00:00Z'),
  sess('c', '2026-05-05T00:00:00Z'),
];

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

describe('resolveTransitionSelection', () => {
  const pending: PendingCreatedSession = {
    sessionId: 'new', profileName: 'sol', override: { model: 'glm-5', thinking: 'high' },
    agentName: null,
  };
  const absent = { profileName: null, override: null };

  it('keeps the chosen draft selection while the new session row is still absent', () => {
    expect(resolveTransitionSelection(absent, pending, 'new')).toEqual({
      profileName: 'sol', override: { model: 'glm-5', thinking: 'high' },
    });
  });

  it('prefers the authoritative session-list row once it arrives', () => {
    expect(resolveTransitionSelection({ profileName: 'execute', override: null }, pending, 'new'))
      .toEqual({ profileName: 'execute', override: null });
  });

  it('carries the row\'s own override, not the pending one', () => {
    expect(resolveTransitionSelection(
      { profileName: 'execute', override: { model: 'claude-haiku-4-5' } }, pending, 'new',
    )).toEqual({ profileName: 'execute', override: { model: 'claude-haiku-4-5' } });
  });

  it('never leaks pending selection metadata into a different session', () => {
    expect(resolveTransitionSelection(absent, pending, 'other')).toEqual(absent);
  });

  // Regression: a session that names no profile still runs the configured default, and its own
  // model/thinking/route choice must survive. Resolving the two halves together used to drop the
  // override with the null profile, so the composer silently fell back to the profile's model.
  it('keeps a profile-less row\'s own selection', () => {
    expect(resolveTransitionSelection(
      { profileName: null, override: { model: 'glm-5', mode: 'api' } }, null, 's1',
    )).toEqual({ profileName: null, override: { model: 'glm-5', mode: 'api' } });
  });

  it('keeps it for a foreign session too — the override belongs to the row, not to the pending marker', () => {
    expect(resolveTransitionSelection(
      { profileName: null, override: { thinking: 'high' } }, pending, 'other',
    )).toEqual({ profileName: null, override: { thinking: 'high' } });
  });
});

describe('applyDraftSelection', () => {
  const draft = { profileName: 'opus', override: { model: 'claude-haiku-4-5', thinking: 'low' } };

  it('a stated selection replaces the whole override', () => {
    expect(applyDraftSelection(draft, { selection: { thinking: 'high' } }))
      .toEqual({ profileName: 'opus', override: { thinking: 'high' } });
  });

  it('an empty stated selection means "follow the profile again"', () => {
    expect(applyDraftSelection(draft, { selection: {} }))
      .toEqual({ profileName: 'opus', override: null });
  });

  it('naming a profile alone drops the overrides, as the server rule does', () => {
    expect(applyDraftSelection(draft, { profileName: 'ds' }))
      .toEqual({ profileName: 'ds', override: null });
  });

  it('a profile and a selection in one change both land', () => {
    expect(applyDraftSelection(draft, { profileName: 'ds', selection: { model: 'glm-5' } }))
      .toEqual({ profileName: 'ds', override: { model: 'glm-5' } });
  });

  it('leaves an untouched draft alone', () => {
    expect(applyDraftSelection(EMPTY_DRAFT_SELECTION, { selection: {} }))
      .toEqual(EMPTY_DRAFT_SELECTION);
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

describe('seedDraftSelection', () => {
  const profiles = [
    { name: 'plan', backend: 'claude', model: 'claude-opus-5' },
    { name: 'sol', backend: 'pi', provider: 'openai-codex', model: 'gpt-6' },
  ] as never as Parameters<typeof seedDraftSelection>[1];

  it('opens a draft on the last engine chosen, override included', () => {
    expect(seedDraftSelection({ profileName: 'sol', model: 'gpt-5.6', thinking: 'high' }, profiles, 'plan'))
      .toEqual({ profileName: 'sol', override: { model: 'gpt-5.6', thinking: 'high' } });
  });

  it('falls back to the configured default when the remembered profile is gone', () => {
    expect(seedDraftSelection({ profileName: 'deleted', model: 'gpt-5.6' }, profiles, 'plan'))
      .toEqual({ profileName: 'plan', override: null });
  });

  it('never re-hangs an override on a substitute profile — it belonged to the other backend', () => {
    expect(seedDraftSelection({ model: 'gpt-5.6' }, profiles, 'plan'))
      .toEqual({ profileName: 'plan', override: null });
  });

  it('has nothing to say when there is neither a remembered pick nor a usable default', () => {
    expect(seedDraftSelection(null, profiles, 'missing')).toBeNull();
    expect(seedDraftSelection(null, [], null)).toBeNull();
  });
});

describe('the environment half of the same transition', () => {
  const pending: PendingCreatedSession = {
    sessionId: 'new', profileName: null, override: null, agentName: 'nimbus',
  };

  it('keeps the agent the draft was created with until its row lands', () => {
    expect(resolveTransitionAgent(undefined, pending, 'new')).toBe('nimbus');
  });

  it('a row that exists answers for itself, including when it follows the default', () => {
    expect(resolveTransitionAgent('orchard', pending, 'new')).toBe('orchard');
    // `null` on a row is a statement, not a gap — the pending pick must not come back here.
    expect(resolveTransitionAgent(null, pending, 'new')).toBeNull();
  });

  it('never leaks the pending pick into a different session', () => {
    expect(resolveTransitionAgent(undefined, pending, 'other')).toBeNull();
  });
});

describe('the draft carries both axes', () => {
  it('an agent pick leaves the engine alone, and an engine pick leaves the agent alone', () => {
    const chosen = applyDraftSelection(
      { profileName: 'opus', override: { model: 'glm-5' } }, { agentName: 'nimbus' },
    );
    expect(chosen).toEqual({ profileName: 'opus', override: { model: 'glm-5' }, agentName: 'nimbus' });
    expect(applyDraftSelection(chosen, { profileName: 'ds' }))
      .toEqual({ profileName: 'ds', override: null, agentName: 'nimbus' });
  });

  it('"default" is a statement the draft keeps, not an absence', () => {
    expect(applyDraftSelection({ profileName: null, override: null, agentName: 'nimbus' }, { agentName: null }))
      .toEqual({ profileName: null, override: null, agentName: null });
  });

  it('opens a draft on the agent last worked in', () => {
    const profiles = [{ name: 'plan', backend: 'claude', model: 'claude-opus-5' }] as never as
      Parameters<typeof seedDraftSelection>[1];
    expect(seedDraftSelection({ profileName: 'plan', agentName: 'nimbus' }, profiles, 'plan'))
      .toEqual({ profileName: 'plan', override: null, agentName: 'nimbus' });
  });
});
