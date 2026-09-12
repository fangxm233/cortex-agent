// input:  respondToPlan, PlanApprovals, InteractionRecords, RunRegistry run.respondToDialog
// output: PI approval delivery and retry-safety regression tests
// pos:    Verifies Web plan responses unblock the waiting backend
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PlanApprovals } from '../../src/orchestration/interactions/plan-approvals.js';
import { respondToPlan } from '../../src/orchestration/interactions/plan-response.js';
import { runRegistry } from '../../src/core/run-registry.js';
import { EventBus } from '../../src/events/index.js';
import * as hookBridge from '../../src/orchestration/routing/hook-bridge.js';

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

function registerPI(
  t: { onTestFinished: (fn: () => void) => void },
  channel: string,
  executionId: string,
  accepted = true,
) {
  const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  runRegistry.register({
    threadId: null,
    channel,
    agentSlotId: null,
    executionId,
    kill: () => true,
    backend: 'pi',
    run: {
      steer: async () => 'refused' as const,
      respondToDialog(id: string, payload: Record<string, unknown>) {
        calls.push({ id, payload });
        return accepted;
      },
    },
  });
  t.onTestFinished(() => runRegistry.remove(executionId));
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

test('a run that declines the dialog falls through to the webhook resolver', async (t) => {
  const channel = 'web:sess-plan-decline';
  const approvals = new PlanApprovals();
  approvals.register('req-decline', { channel, extensionUiId: 'ui-decline' });
  const interactions = makeInteractions();
  const calls = registerPI(t, channel, 'exec-plan-decline', false);

  // A blocking webhook request is waiting on the same requestId — the fall-through target.
  hookBridge.initHookBridge(new EventBus());
  const hookPromise = hookBridge.registerPlanApproval('req-decline', channel, 'sess-decline', 'plan', {});

  const outcome = respondToPlan(
    { planApprovals: approvals, interactionRecords: interactions.service as any },
    'req-decline',
    true,
  );

  assert.equal(calls.length, 1, 'the run is asked once before falling through');
  assert.equal(outcome, 'resolved', 'the webhook resolver still seals the interaction');
  assert.deepEqual(await hookPromise, { approved: true, reason: '' });
  assert.equal(approvals.has('req-decline'), false);
  assert.equal(interactions.resolved[0].status, 'approved');
});

test('with two runs on a channel the first that answers wins and the second is not called', (t) => {
  const channel = 'web:sess-plan-order';
  const approvals = new PlanApprovals();
  approvals.register('req-order', { channel, extensionUiId: 'ui-order' });
  const interactions = makeInteractions();
  const first = registerPI(t, channel, 'exec-plan-order-1');
  const second = registerPI(t, channel, 'exec-plan-order-2');

  const outcome = respondToPlan(
    { planApprovals: approvals, interactionRecords: interactions.service as any },
    'req-order',
    true,
  );

  assert.equal(outcome, 'resolved');
  assert.deepEqual(first, [{ id: 'ui-order', payload: { value: '__APPROVED__' } }]);
  assert.equal(second.length, 0, 'the run after the winner is never asked');
});
