// input:  deliverToSession / buildDeliveryMessage — the one door into a conversation turn
// output: the origin table pinned field by field, plus the two degradations (no adapter, no route)
// pos:    these values used to live in three hand-written builders (session-send `web_`,
//         resume-dispatcher `resume_`, thread-callback `cb_`). Anything that changes a sender id or
//         a messageId prefix here changes ledger keys, chat rendering and mid-turn injection.

import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { SYNTHETIC_CALLBACK_SENDER } from '../../src/platform/types.js';
import {
  WEB_UI_SENDER, buildDeliveryMessage, deliverToSession, type DeliveryOrigin,
} from '../../src/orchestration/session-gateway.js';
import {
  setOrchestrationRuntime, _resetOrchestrationRuntime,
} from '../../src/orchestration/runtime.js';

afterEach(() => { _resetOrchestrationRuntime(); });

const EXPECTED: Record<DeliveryOrigin, { senderId: string; systemOrigin?: string; prefix: RegExp }> = {
  'web-user': { senderId: WEB_UI_SENDER, prefix: /^web_\d+$/ },
  'agent-result': { senderId: WEB_UI_SENDER, systemOrigin: 'agent-result', prefix: /^web_\d+$/ },
  'ask-user-answer': { senderId: WEB_UI_SENDER, prefix: /^web_\d+$/ },
  'resume': { senderId: SYNTHETIC_CALLBACK_SENDER, systemOrigin: 'resume', prefix: /^resume_\d+$/ },
  'thread-callback': { senderId: SYNTHETIC_CALLBACK_SENDER, systemOrigin: 'thread-callback', prefix: /^cb_tg_\d+$/ },
  'task-callback': { senderId: SYNTHETIC_CALLBACK_SENDER, systemOrigin: 'task-callback', prefix: /^cb_tg_\d+$/ },
  'subtask-question': { senderId: SYNTHETIC_CALLBACK_SENDER, systemOrigin: 'subtask-question', prefix: /^cb_tg_\d+$/ },
};

test('every origin maps to its sender id, system origin and messageId prefix', () => {
  for (const [origin, want] of Object.entries(EXPECTED) as Array<[DeliveryOrigin, typeof EXPECTED[DeliveryOrigin]]>) {
    const m = buildDeliveryMessage({ channel: 'C1', text: 'hi', origin, tag: 'tg' });
    assert.equal(m.senderId, want.senderId, `${origin}: senderId`);
    assert.equal(m.systemOrigin, want.systemOrigin, `${origin}: systemOrigin`);
    assert.match(m.ref.messageId, want.prefix, `${origin}: messageId prefix`);
    assert.equal(m.kind, 'user', `${origin}: routed as a user turn`);
    assert.equal(m.isBot, false, `${origin}: not a bot message`);
    assert.equal(m.ref.conduit, 'C1');
    assert.equal(m.text, 'hi');
  }
});

test('a backgrounded agent result keeps a web sender id so it can still fold into a live turn', () => {
  // isInjectableMessage refuses SYNTHETIC_CALLBACK_SENDER; tagging this origin synthetic would
  // push a finished background run behind the queue instead of into the running turn.
  const m = buildDeliveryMessage({ channel: 'C1', text: 'done', origin: 'agent-result' });
  assert.notEqual(m.senderId, SYNTHETIC_CALLBACK_SENDER);
  assert.equal(m.senderId, WEB_UI_SENDER);
});

test('a typed web message is authored by the human — no system origin', () => {
  const m = buildDeliveryMessage({ channel: 'C1', text: 'run the probe', origin: 'web-user' });
  assert.equal('systemOrigin' in m, false);
});

test('raw carries the origin source, and the caller may add fields but not replace it', () => {
  const resume = buildDeliveryMessage({
    channel: 'C1', text: 'reminder', origin: 'resume',
    raw: { originalMessage: 'the first ask', source: 'nope' },
  });
  assert.deepEqual(resume.raw, { source: 'rate-limit-resume', originalMessage: 'the first ask' });
  const wake = buildDeliveryMessage({ channel: 'C1', text: 'n', origin: 'thread-callback', tag: 'thr_1' });
  assert.deepEqual(wake.raw, { source: 'task-callback', tag: 'thr_1' });
});

test('delivery routes a fully-formed turn ctx through the runtime adapter', async () => {
  const adapter = { name: 'mock' } as any;
  setOrchestrationRuntime({ adapter });
  const routed: any[] = [];
  await deliverToSession({
    channel: 'C1', text: 'hello', origin: 'web-user',
    route: async (ctx) => { routed.push(ctx); },
  });
  assert.equal(routed.length, 1);
  assert.equal(routed[0].channel, 'C1');
  assert.equal(routed[0].adapter, adapter, 'adapter comes from the runtime, not the caller');
  assert.equal(routed[0].threadAnchorId, null);
  assert.equal(routed[0].hasFiles, false);
  assert.equal(routed[0].userMessage, 'hello');
  assert.equal(routed[0].agentMessage, 'hello');
  assert.equal(routed[0].message.senderId, WEB_UI_SENDER);
});

test('delivery forwards the origin\'s system origin onto the routed message', async () => {
  // Migrated from the deleted `session-send.test.ts`, where the wrapper passed the tag explicitly;
  // the origin now carries it, so the assertion holds through `deliverToSession` unchanged.
  setOrchestrationRuntime({ adapter: { name: 'mock' } as any });
  const calls: any[] = [];
  await deliverToSession({
    channel: 'C123', text: 'delivered', origin: 'agent-result',
    route: async (ctx) => { calls.push(ctx); },
  });

  assert.equal(calls[0].message.systemOrigin, 'agent-result');
});

test('delivery with nowhere to go is dropped, not queued for hours later', async () => {
  const routed: any[] = [];
  await deliverToSession({
    channel: 'C1', text: 'hello', origin: 'agent-result',
    route: async (ctx) => { routed.push(ctx); },
  });
  assert.deepEqual(routed, [], 'no adapter in the runtime ⇒ logged and dropped');
});
