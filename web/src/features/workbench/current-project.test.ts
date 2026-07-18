import { describe, it, expect } from 'vitest';
import type { ProjectConduitInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { deriveActiveProjectId, resolveCurrentProjectId } from './current-project';

const session = (projectId: string, lastUsedAt: string): SessionInfo => ({
  sessionId: 's_' + Math.random().toString(36).slice(2),
  name: 'cortex-0000',
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
  backgroundRunning: false,
  numTurns: null,
  costUsd: null,
  unread: false,
});

const project = (id: string): ProjectConduitInfo => ({
  id,
  kind: 'research',
  contextDir: '/x/' + id,
  hasMission: true,
  conduits: {},
});

describe('deriveActiveProjectId', () => {
  it('picks the most-recently-used session project', () => {
    const derived = deriveActiveProjectId(
      [
        session('alpha', '2026-07-01T00:00:00Z'),
        session('beta', '2026-07-05T00:00:00Z'),
        session('gamma', '2026-07-03T00:00:00Z'),
      ],
      [project('alpha'), project('beta'), project('gamma')],
    );
    expect(derived).toBe('beta');
  });

  it('falls back to the first listed project when there are no sessions', () => {
    expect(deriveActiveProjectId([], [project('alpha'), project('beta')])).toBe('alpha');
  });

  it('returns null when there are neither sessions nor projects', () => {
    expect(deriveActiveProjectId([], [])).toBeNull();
  });

  it('falls back to the first project when the latest session has no projectId', () => {
    expect(
      deriveActiveProjectId([session('', '2026-07-05T00:00:00Z')], [project('alpha')]),
    ).toBe('alpha');
  });
});

describe('resolveCurrentProjectId', () => {
  it('returns the override when set, even if it differs from the derived default', () => {
    const resolved = resolveCurrentProjectId(
      'gamma',
      [session('beta', '2026-07-05T00:00:00Z')],
      [project('beta'), project('gamma')],
    );
    expect(resolved).toBe('gamma');
  });

  it('falls back to the derived default when no override is set', () => {
    const resolved = resolveCurrentProjectId(
      null,
      [session('beta', '2026-07-05T00:00:00Z')],
      [project('beta')],
    );
    expect(resolved).toBe('beta');
  });
});
