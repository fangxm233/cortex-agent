import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

const flush = () => setImmediate();

import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import { registerCommands as createCommandDispatcher } from '../src/orchestration/routing/commands/index.js';
import { MockAdapter } from '../src/platform/testing.js';
import { runRegistry } from '../src/core/run-registry.js';

// ============================================================
// CommandActionRouter unit tests
// ============================================================

test('CommandActionRouter: registers and binds action handlers to adapter', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  let handlerCalled = false;
  router.registerCommand('test', {
    actions: [{ actionId: 'ping', handler: async () => { handlerCalled = true; } }],
  });
  router.bindToAdapter(adapter);
  await adapter.simulateAction('cmd:test:ping', 'value');
  assert.equal(handlerCalled, true);
});

test('CommandActionRouter: duplicate actionId throws', () => {
  const router = new CommandActionRouter();
  router.registerCommand('test', { actions: [{ actionId: 'foo', handler: async () => {} }] });
  assert.throws(() => {
    router.registerCommand('test', { actions: [{ actionId: 'foo', handler: async () => {} }] });
  }, /duplicate actionId/);
});

test('CommandActionRouter: clearChannelSessions removes sessions for channel only', () => {
  const router = new CommandActionRouter();
  router.createSession('C1', 'a', {});
  router.createSession('C1', 'b', {});
  router.createSession('C2', 'c', {});
  assert.equal(router.getSessionsByChannel('C1').length, 2);
  assert.equal(router.getSessionsByChannel('C2').length, 1);
  router.clearChannelSessions('C1');
  assert.equal(router.getSessionsByChannel('C1').length, 0);
  assert.equal(router.getSessionsByChannel('C2').length, 1);
});

// ============================================================
// Interactive !cancel with 2+ executions
// ============================================================

test('!cancel with 2+ executions shows interactive list with cancel buttons', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    cancelDispatchedTask: null,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  runRegistry.register({
    threadId: 'thr_a1b2c3d4', channel: 'C123', agentSlotId: null, executionId: 'exec-1',
    kill: () => true, backend: 'plan',
  });
  runRegistry.register({
    threadId: 'thr_e5f6g7h8', channel: 'C123', agentSlotId: null, executionId: 'exec-2',
    kill: () => true, backend: 'claudeCode',
  });

  const handled = dispatchCommand('!cancel', 'C123', adapter);
  assert.equal(handled, true);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted, 'expected a posted message');
  const actionsBlock = lastPosted.content.richBlocks?.find(b => b.type === 'actions');
  assert.ok(actionsBlock, 'expected actions in interactive cancel');
  assert.equal(actionsBlock.elements.length, 2, 'expected 2 cancel buttons');
  assert.equal(actionsBlock.elements[0].actionId, 'cmd:cancel:exec-0');
  assert.equal(actionsBlock.elements[1].actionId, 'cmd:cancel:exec-1');

  runRegistry.remove('exec-1');
  runRegistry.remove('exec-2');
});

test('!cancel with 2+ executions: clicking cancel button kills execution', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    cancelDispatchedTask: null,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  runRegistry.register({
    threadId: null, channel: 'C123', agentSlotId: null, executionId: 'exec-cancel-test',
    kill: () => true, backend: 'plan',
  });

  await adapter.simulateAction('cmd:cancel:exec-0',
    JSON.stringify({ threadId: null, executionId: 'exec-cancel-test' }),
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'msg-1' } },
  );

  assert.equal(runRegistry.getById('exec-cancel-test'), null);
  const lastUpdated = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdated, 'expected an updateMessage call');
  runRegistry.remove('exec-cancel-test');
});

// ============================================================
// !cancel backward compat (no interactive)
// ============================================================

test('!cancel with 1 execution falls back to direct cancel', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    cancelDispatchedTask: null,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  runRegistry.register({
    threadId: null, channel: 'C456', agentSlotId: null, executionId: 'exec-single',
    kill: () => true, backend: 'plan',
  });

  dispatchCommand('!cancel', 'C456', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.equal(lastPosted.content.richBlocks, undefined);
  runRegistry.remove('exec-single');
});

// ============================================================
// Interactive !status
// ============================================================

test('!status Refresh button click re-runs report and updates message', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  let callCount = 0;
  const getExecutionStatusReport = () => {
    callCount++;
    return `Report #${callCount}`;
  };
  createCommandDispatcher({
    scheduler: null as any,
    getExecutionStatusReport,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  await adapter.simulateAction('cmd:status:refresh', '',
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'status-msg-1' } },
  );

  assert.equal(callCount, 1, 'should have called getExecutionStatusReport again');
  const lastUpdated = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdated);
  assert.ok(lastUpdated.content.text.includes('Report #1'));
});

// ============================================================
// Interactive !devices (Phase 2)
// ============================================================

// ============================================================
// Interactive !tasks (Phase 2)
// ============================================================

// ============================================================
// Interactive !resume (Phase 3)
// ============================================================

// Note: !resume backward compat test omitted — handleResumeCmd uses async file I/O
// (sessionRegistryRepo) that hangs in the test environment without a real data dir.

// ============================================================
// Interactive !profile (Phase 3)
// ============================================================

// ============================================================
// Interactive !agent (Phase 3)
// ============================================================

// ============================================================
// Interactive !register (Phase 4)
// ============================================================

// ============================================================
// Interactive !project-dir modal (Phase 4)
// ============================================================

// ============================================================
// Interactive !schedule list (Phase 4)
// ============================================================
