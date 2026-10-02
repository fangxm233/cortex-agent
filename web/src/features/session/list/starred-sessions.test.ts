import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { partitionStarredSessions } from './starred-sessions';

const session = (sessionId: string, extra = {}): SessionInfo => ({
  sessionId, projectId: 'alpha', origin: 'direct', ...extra,
}) as SessionInfo;

describe('partitionStarredSessions', () => {
  it('moves direct, commission and scheduled stars out of their original lists', () => {
    const direct = [session('legacy'), session('plain', { starred: false }),
      session('star', { starred: true }), session('commission', { starred: true, commissionId: 'c' })];
    const scheduled = [session('run', { origin: 'scheduled', starred: true }),
      session('other-run', { origin: 'scheduled' })];
    const result = partitionStarredSessions(direct, scheduled);
    expect(result.starred.map(s => s.sessionId)).toEqual(['star', 'commission', 'run']);
    expect(result.direct.map(s => s.sessionId)).toEqual(['legacy', 'plain']);
    expect(result.scheduled.map(s => s.sessionId)).toEqual(['other-run']);
    expect(direct).toHaveLength(4);
    expect(scheduled).toHaveLength(2);
  });

  it('restores unstarred records without changing their original order or binding', () => {
    const direct = [session('a'), session('b', { starred: false, commissionId: 'c' })];
    const scheduled = [session('run', { origin: 'scheduled', starred: false, scheduleId: 's' })];
    expect(partitionStarredSessions(direct, scheduled)).toEqual({ starred: [], direct, scheduled });
  });
});
