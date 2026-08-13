// input:  hook bridge subscribers for web interactions
// output: web sessionId retention from event payload, not channel slicing
// pos:    regression for adopted/non-web-prefixed session ids on web interactions

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/events/event-bus.js';
import { registerHookBridgeSubscribers } from '../../src/orchestration/routing/hook-bridge-subscribers.js';
import { MockAdapter } from '../../src/platform/testing.js';

test('web ask-user interactions persist the provided sessionId rather than channel suffix', async () => {
  const bus = new EventBus();
  const adapter = new MockAdapter();
  const created: any[] = [];
  registerHookBridgeSubscribers(bus, adapter as any, { register() {} } as any, {
    create: async (args: any) => { created.push(args); },
  } as any);

  await bus.publish({
    type: 'ask-user.requested',
    ts: new Date().toISOString(),
    requestId: 'req-1',
    channel: 'web:channel-token',
    sessionId: 'track-real',
    questions: [{ question: 'Q?', header: 'Q', options: [], multiSelect: false }],
  } as any);

  assert.equal(created[0].sessionId, 'track-real');
});

test('web plan interactions persist the provided sessionId rather than channel suffix', async () => {
  const bus = new EventBus();
  const adapter = new MockAdapter();
  const created: any[] = [];
  const planApprovals = { register() {} };
  registerHookBridgeSubscribers(bus, adapter as any, planApprovals as any, {
    create: async (args: any) => { created.push(args); },
  } as any);

  await bus.publish({
    type: 'plan.submitted',
    ts: new Date().toISOString(),
    requestId: 'req-2',
    channel: 'web:channel-token',
    sessionId: 'track-real',
    planContent: '# Plan',
    toolInput: {},
  } as any);

  assert.equal(created[0].sessionId, 'track-real');
});
