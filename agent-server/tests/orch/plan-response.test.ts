// input:  respondToPlan, PlanApprovals, InteractionRecords, RunningExecutions
// output: PI approval delivery and retry-safety regression tests
// pos:    Verifies Web plan responses unblock the waiting backend
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PlanApprovals } from '../../src/orchestration/interactions/plan-approvals.js';
import { respondToPlan } from '../../src/orchestration/interactions/plan-response.js';
import { runningExecutions } from '../../src/core/running-executions.js';

function makeInteractions() {
  const resolved: any[] = [];
  return {
    resolved,
    service: {
      get: () => ({ status: 'pending' }),
      resolve: async (args: any) => { resolved.push(args); return 'resolved' as const; },
    },
  };
}

function registerPI(t: { onTestFinished: (fn: () => void) => void }, channel: string, executionId: string) {
  const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  runningExecutions.register({
    threadId: null,
    channel,
    agentSlotId: null,
    executionId,
    kill: () => true,
    backend: 'pi',
    agentProcess: {
      sendExtensionUiResponse(id: string, payload: Record<string, unknown>) {
        calls.push({ id, payload });
      },
    },
  });
  t.onTestFinished(() => runningExecutions.remove(executionId));
  return calls;
}

test('Web approve sends the PI extension response before sealing the interaction', (t) => {
  const channel = 'web:sess-plan-approve';
  const approvals = new PlanApprovals();
  approvals.register('req-approve', { channel, extensionUiId: 'ui-approve' });
  const interactions = makeInteractions();
  const calls = registerPI(t, channel, 'exec-plan-approve');

  const outcome = respondToPlan(
    { planApprovals: approvals, interactionRecords: interactions.service as any },
    'req-approve',
    true,
  );

  assert.equal(outcome, 'resolved');
  assert.deepEqual(calls, [{ id: 'ui-approve', payload: { value: '__APPROVED__' } }]);
  assert.equal(approvals.has('req-approve'), false);
  assert.equal(interactions.resolved.length, 1);
  assert.equal(interactions.resolved[0].status, 'approved');
});

test('Web reject sends feedback to PI and seals the interaction as rejected', (t) => {
  const channel = 'web:sess-plan-reject';
  const approvals = new PlanApprovals();
  approvals.register('req-reject', { channel, extensionUiId: 'ui-reject' });
  const interactions = makeInteractions();
  const calls = registerPI(t, channel, 'exec-plan-reject');

  const outcome = respondToPlan(
    { planApprovals: approvals, interactionRecords: interactions.service as any },
    'req-reject',
    false,
    'revise the test plan',
  );

  assert.equal(outcome, 'resolved');
  assert.deepEqual(calls, [{ id: 'ui-reject', payload: { value: 'revise the test plan' } }]);
  assert.equal(approvals.has('req-reject'), false);
  assert.equal(interactions.resolved[0].status, 'rejected');
  assert.deepEqual(interactions.resolved[0].result, { feedback: 'revise the test plan' });
});

test('failed PI delivery leaves the pending plan retryable and does not seal the interaction', () => {
  const approvals = new PlanApprovals();
  approvals.register('req-retry', { channel: 'web:sess-plan-missing', extensionUiId: 'ui-missing' });
  const interactions = makeInteractions();

  const outcome = respondToPlan(
    { planApprovals: approvals, interactionRecords: interactions.service as any },
    'req-retry',
    true,
  );

  assert.equal(outcome, 'not-found');
  assert.equal(approvals.has('req-retry'), true);
  assert.equal(interactions.resolved.length, 0);
});
