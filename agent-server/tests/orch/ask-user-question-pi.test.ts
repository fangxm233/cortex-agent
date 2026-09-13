// input:  ask-user-question.tryResolveHook, RunRegistry entries with run.respondToDialog
// output: regression tests for native PI and MCP-over-PI routing
// pos:    verifies extension UI and webhook resolver separation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runRegistry } from '../../src/core/run-registry.js';

function makeMockPIProcess(accepted = true) {
  const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    run: {
      steer: async () => 'refused' as const,
      respondToDialog(id: string, payload: Record<string, unknown>) {
        calls.push({ id, payload });
        return accepted;
      },
    },
  };
}

test('tryResolveHook native PI branch — sends extension_ui_response with joined answer values', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const mockProc = makeMockPIProcess();

  runRegistry.register({
    threadId: null,
    channel: 'C_PI_ASK',
    agentSlotId: null,
    executionId: 'exec-pi-ask-1',
    kill: () => true,
    backend: 'pi',
    run: mockProc.run,
  });
  t.onTestFinished(() => { runRegistry.remove('exec-pi-ask-1'); });

  const group = askUser.createHookGroup('req-pi-ask', 'C_PI_ASK', 'sess-pi-ask', [
    { header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] },
  ], 'ui-req-pi-ask');

  // Simulate answer collection
  const pendingId = group.questions[0].pendingId;
  group.answers.set(pendingId, { value: 'A' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true, 'tryResolveHook should return true for PI branch');
  assert.equal(mockProc.calls.length, 1);
  assert.equal(mockProc.calls[0].id, 'ui-req-pi-ask');
  assert.deepEqual(mockProc.calls[0].payload, { value: 'A' });
});

test('tryResolveHook native PI branch — multi-question joins answers with newline', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const mockProc = makeMockPIProcess();

  runRegistry.register({
    threadId: null,
    channel: 'C_PI_ASK2',
    agentSlotId: null,
    executionId: 'exec-pi-ask-2',
    kill: () => true,
    backend: 'pi',
    run: mockProc.run,
  });
  t.onTestFinished(() => { runRegistry.remove('exec-pi-ask-2'); });

  const group = askUser.createHookGroup('req-pi-ask2', 'C_PI_ASK2', 'sess-pi-ask2', [
    { header: 'Color', question: 'Favorite color?', options: [{ label: 'Red', description: 'R' }] },
    { header: 'Size', question: 'T-shirt size?', options: [{ label: 'M', description: 'Medium' }] },
  ], 'ui-req-pi-ask2');

  group.answers.set(group.questions[0].pendingId, { value: 'Red' });
  group.answers.set(group.questions[1].pendingId, { value: 'M' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true);
  assert.equal(mockProc.calls.length, 1);
  assert.equal(mockProc.calls[0].id, 'ui-req-pi-ask2');
  assert.equal(mockProc.calls[0].payload.value, 'Red\nM');
});

test('tryResolveHook MCP-over-PI branch — resolves blocking webhook instead of extension UI', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const mockProc = makeMockPIProcess();

  runRegistry.register({
    threadId: null,
    channel: 'C_PI_MCP_ASK',
    agentSlotId: null,
    executionId: 'exec-pi-mcp-ask',
    kill: () => true,
    backend: 'pi',
    run: mockProc.run,
  });
  t.onTestFinished(() => { runRegistry.remove('exec-pi-mcp-ask'); });

  let resolvedAnswers: Record<string, string> | null = null;
  askUser.registerHookResolver('req-pi-mcp-ask', (data) => { resolvedAnswers = data.answers; });
  const group = askUser.createHookGroup('req-pi-mcp-ask', 'C_PI_MCP_ASK', 'sess-pi-mcp-ask', [
    { header: 'Deploy', question: 'Deploy now?', options: [{ label: 'Yes', description: 'Deploy' }] },
  ]);
  group.answers.set(group.questions[0].pendingId, { value: 'Yes' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true);
  assert.deepEqual(resolvedAnswers, { 'Deploy now?': 'Yes' });
  assert.equal(mockProc.calls.length, 0, 'MCP request ID must not be sent as a PI extension UI ID');
});

test('tryResolveHook — non-PI backend falls through to Claude resolver', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');

  runRegistry.register({
    threadId: null,
    channel: 'C_CLAUDE_ASK',
    agentSlotId: null,
    executionId: 'exec-claude-ask-1',
    kill: () => true,
    backend: 'claude',
  });
  t.onTestFinished(() => { runRegistry.remove('exec-claude-ask-1'); });

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

  runRegistry.register({
    threadId: null,
    channel: 'C_PI_PARTIAL',
    agentSlotId: null,
    executionId: 'exec-pi-partial',
    kill: () => true,
    backend: 'pi',
    run: mockProc.run,
  });
  t.onTestFinished(() => { runRegistry.remove('exec-pi-partial'); });

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

test('tryResolveHook — PI with no run falls through to Claude path', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');

  runRegistry.register({
    threadId: null,
    channel: 'C_PI_NOPROC',
    agentSlotId: null,
    executionId: 'exec-pi-noproc',
    kill: () => true,
    backend: 'pi',
    // no run
  });
  t.onTestFinished(() => { runRegistry.remove('exec-pi-noproc'); });

  let resolverCalled = false;
  askUser.registerHookResolver('req-pi-noproc', () => { resolverCalled = true; });

  const group = askUser.createHookGroup('req-pi-noproc', 'C_PI_NOPROC', 'sess-pi-noproc', [
    { header: 'Q', question: 'Question?', options: [{ label: 'Ok', description: 'ok' }] },
  ]);

  group.answers.set(group.questions[0].pendingId, { value: 'Ok' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true, 'should fall through to Claude resolver');
  assert.equal(resolverCalled, true, 'Claude resolver should be called when PI has no run');
});

test('tryResolveHook — a run that declines the dialog does not delete the group and reports unresolved', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const mockProc = makeMockPIProcess(false);

  runRegistry.register({
    threadId: null,
    channel: 'C_PI_DECLINED',
    agentSlotId: null,
    executionId: 'exec-pi-declined',
    kill: () => true,
    backend: 'pi',
    run: mockProc.run,
  });
  t.onTestFinished(() => { runRegistry.remove('exec-pi-declined'); });

  const group = askUser.createHookGroup('req-pi-declined', 'C_PI_DECLINED', 'sess-pi-declined', [
    { header: 'Q', question: 'Still there?', options: [{ label: 'Yes', description: 'y' }] },
  ], 'ui-req-pi-declined');
  group.answers.set(group.questions[0].pendingId, { value: 'Yes' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(mockProc.calls.length, 1, 'the run is asked once');
  assert.equal(resolved, false, 'with no webhook waiting the group stays unresolved');
  assert.ok(
    askUser.getGroupByHookRequestId('req-pi-declined'),
    'a declined dialog must not delete the group',
  );
});

test('tryResolveHook — a run that declines the dialog falls through to the blocking webhook', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const mockProc = makeMockPIProcess(false);

  runRegistry.register({
    threadId: null,
    channel: 'C_PI_DECLINED_HOOK',
    agentSlotId: null,
    executionId: 'exec-pi-declined-hook',
    kill: () => true,
    backend: 'pi',
    run: mockProc.run,
  });
  t.onTestFinished(() => { runRegistry.remove('exec-pi-declined-hook'); });

  let resolverAnswers: Record<string, string> | null = null;
  askUser.registerHookResolver('req-pi-declined-hook', (data) => { resolverAnswers = data.answers; });

  const group = askUser.createHookGroup('req-pi-declined-hook', 'C_PI_DECLINED_HOOK', 'sess-pi-declined-hook', [
    { header: 'Q', question: 'Still there?', options: [{ label: 'Yes', description: 'y' }] },
  ], 'ui-req-pi-declined-hook');
  group.answers.set(group.questions[0].pendingId, { value: 'Yes' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(mockProc.calls.length, 1, 'the run is asked once before falling through');
  assert.equal(resolved, true, 'the webhook resolver still resolves the group');
  assert.deepEqual(resolverAnswers, { 'Still there?': 'Yes' });
});

test('tryResolveHook — a run that accepts the dialog resolves and deletes the group', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const mockProc = makeMockPIProcess(true);

  runRegistry.register({
    threadId: null,
    channel: 'C_PI_ACCEPTED',
    agentSlotId: null,
    executionId: 'exec-pi-accepted',
    kill: () => true,
    backend: 'pi',
    run: mockProc.run,
  });
  t.onTestFinished(() => { runRegistry.remove('exec-pi-accepted'); });

  const group = askUser.createHookGroup('req-pi-accepted', 'C_PI_ACCEPTED', 'sess-pi-accepted', [
    { header: 'Q', question: 'Go?', options: [{ label: 'Yes', description: 'y' }] },
  ], 'ui-req-pi-accepted');
  group.answers.set(group.questions[0].pendingId, { value: 'Yes' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true);
  assert.equal(mockProc.calls.length, 1);
  assert.deepEqual(mockProc.calls[0].payload, { value: 'Yes' });
  assert.equal(
    askUser.getGroupByHookRequestId('req-pi-accepted'),
    null,
    'an accepted dialog deletes the group',
  );
});

test('tryResolveHook — with two runs on a channel the first that returns true wins and the second is not called', async (t) => {
  const askUser = await import('../../src/orchestration/interactions/ask-user-question.js');
  const first = makeMockPIProcess(true);
  const second = makeMockPIProcess(true);

  runRegistry.register({
    threadId: null,
    channel: 'C_PI_ORDER',
    agentSlotId: null,
    executionId: 'exec-pi-order-1',
    kill: () => true,
    backend: 'pi',
    run: first.run,
  });
  runRegistry.register({
    threadId: null,
    channel: 'C_PI_ORDER',
    agentSlotId: null,
    executionId: 'exec-pi-order-2',
    kill: () => true,
    backend: 'pi',
    run: second.run,
  });
  t.onTestFinished(() => {
    runRegistry.remove('exec-pi-order-1');
    runRegistry.remove('exec-pi-order-2');
  });

  const group = askUser.createHookGroup('req-pi-order', 'C_PI_ORDER', 'sess-pi-order', [
    { header: 'Q', question: 'Which run?', options: [{ label: 'First', description: '1' }] },
  ], 'ui-req-pi-order');
  group.answers.set(group.questions[0].pendingId, { value: 'First' });

  const resolved = askUser.tryResolveHook(group);
  assert.equal(resolved, true);
  assert.equal(first.calls.length, 1, 'the first run answers the dialog');
  assert.equal(second.calls.length, 0, 'the run after the winner is never asked');
});
