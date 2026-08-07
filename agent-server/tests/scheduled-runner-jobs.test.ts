// input:  job registry dispatch callbacks
// output: missing-runner, failure-isolation and finalize-registration tests
// pos:    Verifies scheduled job dispatch behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { register, dispatch } from '../src/domain/scheduling/job-registry.js';
import { finalizeThreadSuccess } from '../src/domain/scheduling/jobs/_shared.js';
import { sessionStore } from '../src/store/session-registry-repo.js';

const stubAdapter = { updateMessage: async () => ({}) } as any;

test('unknown key dispatch logs a warning and returns false', () => {
  const result = dispatch('nonexistent-key', {});
  assert.equal(result, false, 'dispatch returns false for unknown key');
});

test('one job failure does not break dispatch table', async () => {
  // Register a throwing runner
  const failKey = 'throwing-job';
  let failureCaught = false;
  register(failKey, async () => {
    throw new Error('simulated failure');
  });

  // Register a succeeding runner
  const successKey = 'succeeding-job';
  let successCalled = false;
  register(successKey, async () => {
    successCalled = true;
  });

  // Dispatch the throwing runner — should log error but not throw
  const throwResult = dispatch(failKey, {});
  assert.equal(throwResult, true, 'dispatch for known key returns true');

  // Give the promise a cycle to reject and be caught
  await new Promise(r => setTimeout(r, 50));

  // Dispatch the succeeding runner — should still work
  const successResult = dispatch(successKey, {});
  assert.equal(successResult, true, 'dispatch succeeds after previous failure');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(successCalled, true, 'succeeding runner was called');
});

// ── finalizeThreadSuccess: session registration identity ────────
// The conversation transcript is recorded under the thread step's TRACK sessionId
// (threads/runner.ts). Registering the scheduled session under the backend id instead
// produced ghost records with no transcript — these tests pin the track-id contract.

test('finalizeThreadSuccess registers under the LAST step track id with backend resume target + scheduleId', async () => {
  await finalizeThreadSuccess(stubAdapter, 'proj-a', null, {
    startTime: Date.now(),
    sessionName: 'cortex-fin-01',
    result: { sessionId: 'backend-uuid-1' } as any,
    threadResult: {
      thread: { steps: [{ sessionId: 'track-step-1' }, { sessionId: 'track-step-2' }] },
      totalCostUsd: 0.1, totalNumTurns: 3,
    },
    project: 'proj-a', trigger: 'scheduled', label: 'scan arxiv',
    sessionKind: 'scheduled', sessionOrigin: 'scheduled', statusPrefix: 'Done',
    scheduleId: 'sched-42',
  });

  const rec = await sessionStore.getById('track-step-2');
  assert.ok(rec, 'session registered under the last step track id');
  assert.equal(rec!.name, 'cortex-fin-01');
  assert.equal(rec!.kind, 'scheduled');
  assert.equal(rec!.origin, 'scheduled');
  assert.equal(rec!.scheduleId, 'sched-42');
  assert.equal(rec!.backendSessionId, 'backend-uuid-1', 'backend id kept as the resume target');
  assert.equal(rec!.label, 'scan arxiv');
  assert.equal(await sessionStore.getById('backend-uuid-1'), null, 'no ghost record under the backend id');
});

// onEnd hooks (targetAgent mode, e.g. post-task-hook's compound/commit step) inject an EXTRA step
// after the main agent: it records sessionName=null, runs under the backend resume id, and never
// writes a conversation-history transcript. Registering the run under that step's id yields a
// ghost session — the UI opens the run and renders an EMPTY chat while the real transcript sits
// under the main step's track id. Real agent steps always carry a sessionName (minted at step
// start), so registration must key on the last REAL step, not the last recorded step.

test('finalizeThreadSuccess skips hook-injected steps when picking the run track id', async () => {
  await finalizeThreadSuccess(stubAdapter, 'proj-d', null, {
    startTime: Date.now(),
    sessionName: 'cortex-fin-04',
    result: { sessionId: 'backend-uuid-4' } as any,
    threadResult: {
      thread: {
        steps: [
          { agentSlotId: 'scheduler-main', sessionId: 'track-main', sessionName: 'cortex-real' },
          // targetAgent-mode hook step: sessionName null, sessionId = backend resume id
          { agentSlotId: 'scheduler-main', sessionId: 'backend-uuid-4', sessionName: null },
          // legacy insertAgent-mode hook step (defensive exclusion)
          { agentSlotId: 'hook:end', sessionId: 'hook-backend-id', sessionName: 'cortex-hook' },
        ],
      },
      totalCostUsd: 0.1, totalNumTurns: 3,
    },
    project: 'proj-d', trigger: 'scheduled', label: 'scan arxiv',
    sessionKind: 'scheduled', sessionOrigin: 'scheduled', statusPrefix: 'Done',
    scheduleId: 'sched-43',
  });

  const rec = await sessionStore.getById('track-main');
  assert.ok(rec, 'session registered under the last REAL agent step track id');
  assert.equal(rec!.name, 'cortex-fin-04');
  assert.equal(rec!.scheduleId, 'sched-43');
  assert.equal(rec!.backendSessionId, 'backend-uuid-4', 'backend id kept as the resume target');
  assert.equal(await sessionStore.getById('backend-uuid-4'), null, 'no ghost record under the hook step id');
  assert.equal(await sessionStore.getById('hook-backend-id'), null, 'no ghost record under a hook: slot id');
});

test('finalizeThreadSuccess falls back to result.sessionId when the thread has no steps', async () => {
  await finalizeThreadSuccess(stubAdapter, 'proj-b', null, {
    startTime: Date.now(),
    sessionName: 'cortex-fin-02',
    result: { sessionId: 'backend-uuid-2' } as any,
    threadResult: { totalCostUsd: 0, totalNumTurns: 1 },
    project: 'proj-b', trigger: 'scheduled', label: null,
    sessionKind: 'scheduled', sessionOrigin: 'scheduled', statusPrefix: 'Done',
  });

  const rec = await sessionStore.getById('backend-uuid-2');
  assert.ok(rec, 'stepless run registers under the agent result id (legacy conflated id)');
  assert.equal(rec!.scheduleId, null, 'no scheduleId when the caller passes none');
});

test('finalizeThreadSuccess registers nothing without a result session id', async () => {
  await finalizeThreadSuccess(stubAdapter, 'proj-c', null, {
    startTime: Date.now(),
    sessionName: 'cortex-fin-03',
    result: null,
    threadResult: { thread: { steps: [{ sessionId: 'track-orphan' }] } },
    project: 'proj-c', trigger: 'scheduled', label: null,
    sessionKind: 'scheduled', sessionOrigin: 'scheduled', statusPrefix: 'Done',
  });

  assert.equal(await sessionStore.getById('track-orphan'), null, 'no registration without an agent result');
});
