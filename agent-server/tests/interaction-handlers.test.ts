// input:  interaction-handlers, EventBus, MockAdapter, ask-user-question
// output: regression tests for handleModalSubmit → bus.publish('ask-user.answered') chain
// pos:    verifies BLK-1 fix: ask-user.answered published with correct payload before hook resolution
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../src/events/event-bus.js';
import type { CortexEvent } from '../src/events/event-types.js';
import { MockAdapter } from '../src/platform/testing.js';

// ── (1) handleModalSubmit publishes ask-user.answered when all answers collected ──

test('handleModalSubmit publishes ask-user.answered with correct payload (hook mode, all answers collected)', async () => {
  const bus = new EventBus();
  const mockAdapter = new MockAdapter();

  // Import modules — module-level singletons are shared within a test run;
  // re-calling init functions resets _bus / _adapter as needed.
  const mod = await import('../src/orchestration/interactions/interaction-handlers.js');
  const askUser = await import('../src/orchestration/interactions/ask-user-question.js');

  mod.initInteractionHandlers(bus);
  mod.registerInteractionHandlers(mockAdapter);

  // Hook-mode group: tryResolveHook returns true (resolver registered) so
  // dispatchAskUserQuestionResume is NOT reached — avoids agent-lifecycle.ts deps.
  const group = askUser.createHookGroup('req-smoke', 'C_SMOKE', 'sess-smoke', [
    { header: 'Approach', question: 'Which approach?', options: [{ label: 'Option A', description: 'First choice' }] },
  ]);
  // Register resolver so tryResolveHook can succeed
  askUser.registerHookResolver('req-smoke', () => {});

  const received: CortexEvent[] = [];
  bus.subscribe('ask-user.answered', (e) => { received.push(e); });

  // Simulate Slack modal submit: q_0 blockId, 'selection' actionId, option index '0'
  await mockAdapter.simulateModalSubmit(
    'ask_user_question_modal_submit',
    { 'q_0': { selection: { selectedOption: { value: '0' } } } },
    { privateMetadata: JSON.stringify({ groupId: group.groupId }) },
  );

  assert.equal(received.length, 1, 'exactly one ask-user.answered event published');
  const ev = received[0] as Extract<CortexEvent, { type: 'ask-user.answered' }>;
  assert.equal(ev.type, 'ask-user.answered');
  assert.equal(ev.channel, 'C_SMOKE');
  assert.equal(ev.sessionId, 'sess-smoke');
  assert.equal(ev.requestId, 'req-smoke');
  assert.ok(ev.answer.includes('Option A'), `answer should include "Option A", got: ${ev.answer}`);
});
