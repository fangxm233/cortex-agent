// input:  ask-user-question.tryResolveHook, RunningExecutions
// output: regression tests for PI branch in tryResolveHook — sendExtensionUiResponse routing
// pos:    verifies S3 invariant: PI ask-user-question resolves via extension_ui_response, not new turn
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runningExecutions } from '../../src/core/running-executions.js';

function makeMockPIProcess() {
  const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    sendExtensionUiResponse(id: string, payload: Record<string, unknown>) {
      calls.push({ id, payload });
    },
  };
}

test('tryResolveHook PI branch — sends extension_ui_response with joined answer values', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const mockProc = makeMockPIProcess();

  runningExecutions.register({
    threadId: null,
    channel: 'C_PI_ASK',
    agentSlotId: null,
    executionId: 'exec-pi-ask-1',
    kill: () => true,
    backend: 'pi',
    agentProcess: mockProc,
  });
  t.onTestFinished(() => { runningExecutions.remove('exec-pi-ask-1'); });

  const group = askUser.createHookGroup('req-pi-ask', 'C_PI_ASK', 'sess-pi-ask', [
    { header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] },
  ]);

  // Simulate answer collection
  const pendingId = group.questions[0].pendingId;
  group.answers.set(pendingId, { value: 'A' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true, 'tryResolveHook should return true for PI branch');
  assert.equal(mockProc.calls.length, 1);
  assert.equal(mockProc.calls[0].id, 'req-pi-ask');
  assert.deepEqual(mockProc.calls[0].payload, { value: 'A' });
});

test('tryResolveHook PI branch — multi-question joins answers with newline', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const mockProc = makeMockPIProcess();

  runningExecutions.register({
    threadId: null,
    channel: 'C_PI_ASK2',
    agentSlotId: null,
    executionId: 'exec-pi-ask-2',
    kill: () => true,
    backend: 'pi',
    agentProcess: mockProc,
  });
  t.onTestFinished(() => { runningExecutions.remove('exec-pi-ask-2'); });

  const group = askUser.createHookGroup('req-pi-ask2', 'C_PI_ASK2', 'sess-pi-ask2', [
    { header: 'Color', question: 'Favorite color?', options: [{ label: 'Red', description: 'R' }] },
    { header: 'Size', question: 'T-shirt size?', options: [{ label: 'M', description: 'Medium' }] },
  ]);

  group.answers.set(group.questions[0].pendingId, { value: 'Red' });
  group.answers.set(group.questions[1].pendingId, { value: 'M' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true);
  assert.equal(mockProc.calls.length, 1);
  assert.equal(mockProc.calls[0].payload.value, 'Red\nM');
});

test('tryResolveHook — non-PI backend falls through to Claude resolver', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');

  runningExecutions.register({
    threadId: null,
    channel: 'C_CLAUDE_ASK',
    agentSlotId: null,
    executionId: 'exec-claude-ask-1',
    kill: () => true,
    backend: 'claude',
  });
  t.onTestFinished(() => { runningExecutions.remove('exec-claude-ask-1'); });

  let resolverCalled = false;
  askUser.registerHookResolver('req-claude-ask', () => { resolverCalled = true; });

  const group = askUser.createHookGroup('req-claude-ask', 'C_CLAUDE_ASK', 'sess-claude-ask', [
    { header: 'Q', question: 'Question?', options: [{ label: 'Yes', description: 'Y' }] },
  ]);

  group.answers.set(group.questions[0].pendingId, { value: 'Yes' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true, 'Claude path should also resolve');
  assert.equal(resolverCalled, true, 'Claude resolver callback must be called');
});

test('tryResolveHook — incomplete answers do not resolve (PI or Claude)', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const mockProc = makeMockPIProcess();

  runningExecutions.register({
    threadId: null,
    channel: 'C_PI_PARTIAL',
    agentSlotId: null,
    executionId: 'exec-pi-partial',
    kill: () => true,
    backend: 'pi',
    agentProcess: mockProc,
  });
  t.onTestFinished(() => { runningExecutions.remove('exec-pi-partial'); });

  const group = askUser.createHookGroup('req-pi-partial', 'C_PI_PARTIAL', 'sess-pi-partial', [
    { header: 'A', question: 'First?', options: [{ label: 'X', description: 'x' }] },
    { header: 'B', question: 'Second?', options: [{ label: 'Y', description: 'y' }] },
  ]);

  // Only answer first question
  group.answers.set(group.questions[0].pendingId, { value: 'X' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, false, 'must not resolve until all answers collected');
  assert.equal(mockProc.calls.length, 0, 'no extension_ui_response should be sent');
});

test('tryResolveHook — PI with no agentProcess falls through to Claude path', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');

  runningExecutions.register({
    threadId: null,
    channel: 'C_PI_NOPROC',
    agentSlotId: null,
    executionId: 'exec-pi-noproc',
    kill: () => true,
    backend: 'pi',
    // no agentProcess
  });
  t.onTestFinished(() => { runningExecutions.remove('exec-pi-noproc'); });

  let resolverCalled = false;
  askUser.registerHookResolver('req-pi-noproc', () => { resolverCalled = true; });

  const group = askUser.createHookGroup('req-pi-noproc', 'C_PI_NOPROC', 'sess-pi-noproc', [
    { header: 'Q', question: 'Question?', options: [{ label: 'Ok', description: 'ok' }] },
  ]);

  group.answers.set(group.questions[0].pendingId, { value: 'Ok' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true, 'should fall through to Claude resolver');
  assert.equal(resolverCalled, true, 'Claude resolver should be called when PI has no agentProcess');
});
