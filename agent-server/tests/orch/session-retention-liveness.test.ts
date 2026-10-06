import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSessionRetentionLiveness } from '../../src/orchestration/session-retention-liveness.js';

test('retention liveness protects live execution ids, bg holds, and pending interactions', () => {
  const snapshot = buildSessionRetentionLiveness({
    runningExecutions: {
      getAll: () => [
        { trackSessionId: 'track-run', backendSessionId: 'backend-run', sessionId: 'track-run' },
        { trackSessionId: null, backendSessionId: 'backend-legacy', sessionId: 'backend-legacy' },
      ],
    } as any,
    bgHeldSessions: { listIds: () => ['track-bg'] },
    interactionRecords: { pendingSessionIds: () => ['track-pending'] },
    pendingDirectResumeSessionIds: ['track-resume'],
    activeClaudeCapturePaths: ['/tmp/cap-a.jsonl'],
    activeClaudeCapturePairs: ['pair-a'],
  });

  assert.deepEqual(new Set(snapshot.protectedTrackSessionIds), new Set([
    'track-run', 'track-bg', 'track-pending', 'track-resume',
  ]));
  assert.deepEqual(new Set(snapshot.protectedBackendSessionIds), new Set([
    'backend-run', 'backend-legacy',
  ]));
  assert.deepEqual(snapshot.activeClaudeCapturePaths, ['/tmp/cap-a.jsonl']);
  assert.deepEqual(snapshot.activeClaudeCapturePairs, ['pair-a']);
});

test('retention liveness protects exactly the ids a live execution carries', () => {
  const snapshot = buildSessionRetentionLiveness({
    runningExecutions: {
      getAll: () => [
        // An execution with no session id at all protects nothing — there is no third field to
        // fall back on, and `register()` never produced one (it derived its ids from these two).
        {},
        { backendSessionId: 'backend-real' },
      ],
    } as any,
  });

  assert.deepEqual(snapshot.protectedTrackSessionIds, []);
  assert.deepEqual(new Set(snapshot.protectedBackendSessionIds), new Set(['backend-real']));
});
