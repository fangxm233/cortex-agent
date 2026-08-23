// input:  Hook bridge events, EventBus, interaction records
// output: Web question and plan interaction persistence tests
// pos:    Tests hook-to-Web interaction delivery
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/events/event-bus.js';
import type { CortexEvent } from '../../src/events/event-types.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { PlanApprovals } from '../../src/orchestration/interactions/plan-approvals.js';
import { InteractionRecords } from '../../src/orchestration/interactions/interaction-records.js';
import { registerHookBridgeSubscribers } from '../../src/orchestration/routing/hook-bridge-subscribers.js';
import { initHookBridge } from '../../src/orchestration/routing/hook-bridge.js';

function makeFakeHistory() {
  const created: any[] = [];
  return {
    created,
    history: {
      appendInteractionCreated: async (sessionId: string, args: any) => { created.push({ sessionId, args }); },
      appendInteractionResolved: async (_sessionId: string, _args: any) => {},
    },
  };
}

function setup() {
  const bus = new EventBus();
  initHookBridge(bus);
  const adapter = new MockAdapter();
  const planApprovals = new PlanApprovals(bus);
  const interactions = new InteractionRecords();
  const fake = makeFakeHistory();
  interactions.init({ history: fake.history as any, bus });
  registerHookBridgeSubscribers(bus, adapter as any, planApprovals, interactions);
  const events: CortexEvent[] = [];
  bus.subscribe('session.interaction', (e) => { events.push(e); });
  return { bus, adapter, planApprovals, interactions, fake, events };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test('plan.submitted on a web channel creates a plan-approval record with full planContent snapshot', async () => {
  const { bus, planApprovals, interactions, fake, events } = setup();

  bus.publish({
    type: 'plan.submitted',
    requestId: 'req-plan-1',
    channel: 'web:sess-9',
    sessionId: 'agent-sess',
    threadId: null,
    planContent: '# Big Plan\n1. do things',
    toolInput: { plan_file_path: 'plan/big.md' },
  });
  await flush();

  // Entity created with the full content snapshot under the agent session.
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].sessionId, 'agent-sess');
  assert.equal(fake.created[0].args.id, 'req-plan-1');
  assert.equal(fake.created[0].args.kind, 'plan-approval');
  assert.equal(fake.created[0].args.payload.planContent, '# Big Plan\n1. do things');
  assert.equal(fake.created[0].args.payload.planFilePath, 'plan/big.md');

  // session.interaction pending event reached subscribers.
  assert.equal(events.length, 1);
  const ev = events[0] as Extract<CortexEvent, { type: 'session.interaction' }>;
  assert.equal(ev.interactionId, 'req-plan-1');
  assert.equal(ev.status, 'pending');

  // The live resolver map is still registered (needed to resolve the blocked MCP tool).
  assert.equal(planApprovals.has('req-plan-1'), true);
  assert.equal(interactions.isPending('req-plan-1'), true);
});

test('ask-user.requested on a web channel creates an ask-user record with normalized questions', async () => {
  const { bus, fake, events } = setup();

  bus.publish({
    type: 'ask-user.requested',
    requestId: 'req-ask-1',
    channel: 'web:sess-9',
    sessionId: 'agent-sess',
    threadId: null,
    questions: [{ question: 'A or B?', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
  });
  await flush();

  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].sessionId, 'agent-sess');
  assert.equal(fake.created[0].args.kind, 'ask-user');
  const qs = fake.created[0].args.payload.questions;
  assert.equal(qs.length, 1);
  assert.equal(qs[0].question, 'A or B?');
  assert.deepEqual(qs[0].options, [{ label: 'A' }, { label: 'B' }]);

  assert.equal(events.length, 1);
  assert.equal((events[0] as any).kind, 'ask-user');
});

test('ask-user.requested with a level persists it in the web interaction payload', async () => {
  const { bus, fake } = setup();

  bus.publish({
    type: 'ask-user.requested',
    requestId: 'req-ask-lvl',
    channel: 'web:sess-lvl',
    sessionId: 'agent-sess',
    threadId: null,
    level: 'warning',
    questions: [{ question: 'Proceed?', header: 'Risk', options: [], multiSelect: false }],
  });
  await flush();

  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].args.payload.level, 'warning');
});

test('ask-user.requested without a level leaves the payload level absent', async () => {
  const { bus, fake } = setup();

  bus.publish({
    type: 'ask-user.requested',
    requestId: 'req-ask-nolvl',
    channel: 'web:sess-nolvl',
    sessionId: 'agent-sess',
    threadId: null,
    questions: [{ question: 'Plain?', header: 'Plain', options: [], multiSelect: false }],
  });
  await flush();

  assert.equal(fake.created.length, 1);
  assert.equal('level' in fake.created[0].args.payload, false);
});

test('ask-user.requested with a level prefixes the Slack summary and blocks with the icon', async () => {
  const { bus, adapter } = setup();

  bus.publish({
    type: 'ask-user.requested',
    requestId: 'req-ask-slack-lvl',
    channel: 'C_SLACK_LVL',
    sessionId: 'agent-sess',
    threadId: null,
    level: 'error',
    questions: [{ question: 'Abort?', header: 'Failure', options: [], multiSelect: false }],
  });
  await flush();

  assert.equal(adapter.posted.length, 1);
  const content = adapter.posted[0].content as any;
  assert.ok(content.text.startsWith('❌'), `summary text carries the error icon: ${content.text}`);
  const first = content.richBlocks[0];
  assert.equal(first.type, 'context');
  assert.ok(String(first.text).includes('❌'), 'first block is the level banner');
});

test('non-web channels do not create interaction records', async () => {
  const { bus, fake } = setup();

  bus.publish({
    type: 'plan.submitted',
    requestId: 'req-slack',
    channel: 'C_SLACK',
    sessionId: 'agent-sess',
    threadId: null,
    planContent: 'x',
    toolInput: {},
  });
  await flush();

  assert.equal(fake.created.length, 0, 'slack channel handled by adapter path, no entity');
});
