import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { filterProjectSessions } from './useProjectSessions';

function session(sessionId: string, projectId: string): SessionInfo {
  return { sessionId, projectId } as SessionInfo;
}

describe('filterProjectSessions', () => {
  const sessions = [session('a', 'atlas'), session('b', 'nimbus')];

  it('projects the shared registry onto one project', () => {
    expect(filterProjectSessions(sessions, 'nimbus')).toEqual([sessions[1]]);
  });

  it('keeps the unscoped registry while project selection is unresolved', () => {
    expect(filterProjectSessions(sessions, null)).toBe(sessions);
  });
});
