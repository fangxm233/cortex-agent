import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PlanApprovals } from '../../src/orchestration/interactions/plan-approvals.js';
import { respondToPlan } from '../../src/orchestration/interactions/plan-response.js';
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

test('failed delivery leaves the pending plan retryable and does not seal the interaction', () => {
  const approvals = new PlanApprovals();
  approvals.register('req-retry', { channel: 'web:sess-plan-missing' });
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

test('a response resolves the waiting webhook request and seals the interaction', async () => {
  const channel = 'web:sess-plan-webhook';
  const approvals = new PlanApprovals();
  approvals.register('req-webhook', { channel });
  const interactions = makeInteractions();

  hookBridge.initHookBridge(new EventBus());
  const hookPromise = hookBridge.registerPlanApproval('req-webhook', channel, 'sess-webhook', 'plan', {});

  const outcome = respondToPlan(
    { planApprovals: approvals, interactionRecords: interactions.service as any },
    'req-webhook',
    true,
  );

  assert.equal(outcome, 'resolved', 'the webhook resolver seals the interaction');
  assert.deepEqual(await hookPromise, { approved: true, reason: '' });
  assert.equal(approvals.has('req-webhook'), false);
  assert.equal(interactions.resolved[0].status, 'approved');
});
