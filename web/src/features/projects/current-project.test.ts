// input:  project/session fixtures and explicit project overrides
// output: shared current-project derivation regression coverage
// pos:    Project selection resolver unit specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { ProjectConduitInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { deriveActiveProjectId, resolveCurrentProjectId } from './current-project';

const session = (projectId: string, lastUsedAt: string): SessionInfo => ({
  sessionId: `s-${projectId}-${lastUsedAt}`,
  backendSessionId: null,
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
  awaitingInput: false,
  numTurns: null,
  costUsd: null,
  unread: false,
  scheduleId: null,
});

const project = (id: string): ProjectConduitInfo => ({
  id,
  kind: 'research',
  contextDir: `/x/${id}`,
  hasMission: true,
  conduits: {},
});

describe('deriveActiveProjectId', () => {
  it('picks the most-recently-used session project', () => {
    expect(deriveActiveProjectId(
      [
        session('alpha', '2026-07-01T00:00:00Z'),
        session('beta', '2026-07-05T00:00:00Z'),
        session('gamma', '2026-07-03T00:00:00Z'),
      ],
      [project('alpha'), project('beta'), project('gamma')],
    )).toBe('beta');
  });

  it('falls back to the first listed project when no session supplies a project', () => {
    expect(deriveActiveProjectId([], [project('alpha'), project('beta')])).toBe('alpha');
    expect(deriveActiveProjectId(
      [session('', '2026-07-05T00:00:00Z')],
      [project('alpha')],
    )).toBe('alpha');
  });

  it('returns null when there are neither sessions nor projects', () => {
    expect(deriveActiveProjectId([], [])).toBeNull();
  });
});

describe('resolveCurrentProjectId', () => {
  it('keeps an explicit selection ahead of the derived default', () => {
    expect(resolveCurrentProjectId(
      'gamma',
      [session('beta', '2026-07-05T00:00:00Z')],
      [project('beta'), project('gamma')],
    )).toBe('gamma');
  });

  it('uses the shared derivation when no override is set', () => {
    expect(resolveCurrentProjectId(
      null,
      [session('beta', '2026-07-05T00:00:00Z')],
      [project('beta')],
    )).toBe('beta');
  });
});
