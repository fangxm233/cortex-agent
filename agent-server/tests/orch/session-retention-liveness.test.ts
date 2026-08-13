// input:  retention liveness builder seams
// output: protection coverage for live executions, thread states, bg holds, interactions, captures
// pos:    unit coverage for retention liveness assembly

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSessionRetentionLiveness } from '../../src/core/session-retention-liveness.js';

test('retention liveness protects live execution ids, active thread ids, bg holds, and pending interactions', () => {
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
    threads: [
      {
        status: 'running',
        agents: { a: { sessionId: 'track-agent', backendSessionId: 'backend-agent' } },
        steps: [{ sessionId: 'track-step', backendSessionId: 'backend-step' }],
      },
      {
        status: 'rate_limited',
        agents: { a: { sessionId: 'track-rate', backendSessionId: undefined } },
        steps: [],
      },
      {
        status: 'completed',
        agents: { a: { sessionId: 'track-done', backendSessionId: 'backend-done' } },
        steps: [{ sessionId: 'track-done-step', backendSessionId: 'backend-done-step' }],
      },
    ] as any,
    activeClaudeCapturePaths: ['/tmp/cap-a.jsonl'],
    activeClaudeCapturePairs: ['pair-a'],
  });

  assert.deepEqual(new Set(snapshot.protectedTrackSessionIds), new Set([
    'track-run', 'track-bg', 'track-pending', 'track-resume', 'track-agent', 'track-step', 'track-rate',
  ]));
  assert.deepEqual(new Set(snapshot.protectedBackendSessionIds), new Set([
    'backend-run', 'backend-legacy', 'backend-agent', 'backend-step', 'track-rate',
  ]));
  assert.deepEqual(snapshot.activeClaudeCapturePaths, ['/tmp/cap-a.jsonl']);
  assert.deepEqual(snapshot.activeClaudeCapturePairs, ['pair-a']);
});

test('retention liveness treats legacy execution sessionId as conservative dual protection only when both explicit ids are absent', () => {
  const snapshot = buildSessionRetentionLiveness({
    runningExecutions: {
      getAll: () => [
        { sessionId: 'legacy-both-missing' },
        { sessionId: 'legacy-backend-only', backendSessionId: 'backend-real' },
      ],
    } as any,
  });

  assert.deepEqual(new Set(snapshot.protectedTrackSessionIds), new Set(['legacy-both-missing']));
  assert.deepEqual(new Set(snapshot.protectedBackendSessionIds), new Set(['legacy-both-missing', 'backend-real']));
});
