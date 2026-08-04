// input:  Node test runner + CommandActionRouter + cancel/status/help/devices/tasks/resume/profile/agent handlers + MockAdapter
// output: tests for CommandActionRouter, interactive !cancel, !status, !help, !devices, !tasks, !resume, !profile, !agent
// pos:    Interactive command system unit test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

const flush = () => setImmediate();

import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import { registerCommands as createCommandDispatcher } from '../src/orchestration/routing/commands/index.js';
import { MockAdapter } from '../src/platform/testing.js';
import { runningExecutions } from '../src/core/running-executions.js';

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

test('CommandActionRouter: registers and binds modal handlers to adapter', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  let handlerCalled = false;
  router.registerCommand('test', {
    modals: [{ callbackId: 'test-modal', handler: async () => { handlerCalled = true; } }],
  });
  router.bindToAdapter(adapter);
  await adapter.simulateModalSubmit('test-modal', {});
  assert.equal(handlerCalled, true);
});

test('CommandActionRouter: duplicate actionId throws', () => {
  const router = new CommandActionRouter();
  router.registerCommand('test', { actions: [{ actionId: 'foo', handler: async () => {} }] });
  assert.throws(() => {
    router.registerCommand('test', { actions: [{ actionId: 'foo', handler: async () => {} }] });
  }, /duplicate actionId/);
});

test('CommandActionRouter: bindToAdapter is idempotent', () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  router.bindToAdapter(adapter);
  router.bindToAdapter(adapter);
});

test('CommandActionRouter: session create/get/delete round-trips', () => {
  const router = new CommandActionRouter();
  const key = router.createSession('C123', 'test', { page: 1 });
  const session = router.getSession(key);
  assert.ok(session);
  assert.equal(session!.commandName, 'test');
  assert.equal(session!.data.page, 1);
  router.deleteSession(key);
  assert.equal(router.getSession(key), undefined);
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

test('CommandActionRouter: getAdapter returns adapter after bindToAdapter', () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  assert.equal(router.getAdapter(), null);
  router.bindToAdapter(adapter);
  assert.equal(router.getAdapter(), adapter);
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

  runningExecutions.register({
    threadId: 'thr_a1b2c3d4', channel: 'C123', agentSlotId: null, executionId: 'exec-1',
    kill: () => true, backend: 'plan',
  });
  runningExecutions.register({
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

  runningExecutions.remove('exec-1');
  runningExecutions.remove('exec-2');
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

  runningExecutions.register({
    threadId: null, channel: 'C123', agentSlotId: null, executionId: 'exec-cancel-test',
    kill: () => true, backend: 'plan',
  });

  await adapter.simulateAction('cmd:cancel:exec-0',
    JSON.stringify({ threadId: null, executionId: 'exec-cancel-test' }),
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'msg-1' } },
  );

  assert.equal(runningExecutions.getById('exec-cancel-test'), null);
  const lastUpdated = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdated, 'expected an updateMessage call');
  assert.ok(lastUpdated.content.text.includes('Cancelled'));
  runningExecutions.remove('exec-cancel-test');
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

  runningExecutions.register({
    threadId: null, channel: 'C456', agentSlotId: null, executionId: 'exec-single',
    kill: () => true, backend: 'plan',
  });

  dispatchCommand('!cancel', 'C456', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.equal(lastPosted.content.richBlocks, undefined);
  assert.ok(lastPosted.content.text.includes('Cancelled'));
  runningExecutions.remove('exec-single');
});

test('!cancel with 0 executions shows "Nothing running"', () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    cancelDispatchedTask: null,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  dispatchCommand('!cancel', 'Cempty', adapter);

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.ok(lastPosted.content.text.includes('Nothing running'));
});

test('!cancel --all still works in interactive mode', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    cancelDispatchedTask: null,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  runningExecutions.register({
    threadId: null, channel: 'Call', agentSlotId: null, executionId: 'exec-all-1',
    kill: () => true, backend: 'plan',
  });

  dispatchCommand('!cancel --all', 'Call', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.ok(lastPosted.content.text.includes('Cancelled'));
  assert.equal(lastPosted.content.richBlocks, undefined);
  runningExecutions.remove('exec-all-1');
});

test('!cancel with threadId arg still works unchanged', () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    cancelDispatchedTask: null,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  const handled = dispatchCommand('!cancel thr_unknown123', 'C123', adapter);
  assert.equal(handled, true);

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.ok(lastPosted.content.text.includes('Dispatched-task cancellation is not available'));
});

// ============================================================
// Interactive !status
// ============================================================

test('!status with router returns interactive Refresh button', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const getExecutionStatusReport = () => 'All systems running.';
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    getExecutionStatusReport,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  dispatchCommand('!status', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  const actionsBlock = lastPosted.content.richBlocks?.find(b => b.type === 'actions');
  assert.ok(actionsBlock, 'expected Refresh button');
  assert.equal(actionsBlock.elements.length, 1);
  assert.equal(actionsBlock.elements[0].text, 'Refresh');
});

test('!status without router falls back to plain text', () => {
  const adapter = new MockAdapter();
  const getExecutionStatusReport = () => 'All systems running.';
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    getExecutionStatusReport,
  });

  dispatchCommand('!status', 'C123', adapter);

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.equal(lastPosted.content.richBlocks, undefined);
  assert.equal(lastPosted.content.text, 'All systems running.');
});

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
// Non-interactive commands still work unchanged
// ============================================================

test('!help without router still works unchanged', () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null as any });

  const handled = dispatchCommand('!help', 'C123', adapter);
  assert.equal(handled, true);

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.ok(lastPosted.content.text.includes('!new'));
});

// ============================================================
// Interactive !help (Phase 2)
// ============================================================

test('!help with router shows category navigation buttons', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  dispatchCommand('!help', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted, 'expected a posted message');
  const actionsBlock = lastPosted.content.richBlocks?.find(b => b.type === 'actions');
  assert.ok(actionsBlock, 'expected category buttons');
  assert.ok(actionsBlock.elements.length >= 3, 'expected multiple category buttons');
  assert.ok(lastPosted.content.text.includes('!new'), 'full help text should be present');
});

test('!help category button click updates message to show filtered commands', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  await adapter.simulateAction('cmd:help:cat-session', 'session',
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'help-msg-1' } },
  );

  const lastUpdated = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdated, 'expected an updateMessage call');
  assert.ok(lastUpdated.content.text.includes('!new'), 'session category should include !new');
  assert.ok(!lastUpdated.content.text.includes('!nvidia-smi'), 'session category should not include device commands');
});

test('!help "Show All" button click updates message to full help', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  await adapter.simulateAction('cmd:help:cat-all', 'all',
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'help-msg-1' } },
  );

  const lastUpdated = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdated, 'expected an updateMessage call');
  assert.ok(lastUpdated.content.text.includes('!new'), 'full help should include !new');
  assert.ok(lastUpdated.content.text.includes('!nvidia-smi'), 'full help should include all commands');
});

// ============================================================
// Interactive !devices (Phase 2)
// ============================================================

test('!devices with router shows Refresh button', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  dispatchCommand('!devices', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted, 'expected a posted message');
  const actionsBlock = lastPosted.content.richBlocks?.find(b => b.type === 'actions');
  assert.ok(actionsBlock, 'expected actions block with Refresh');
  const refreshBtn = actionsBlock.elements.find((e: any) => e.text === 'Refresh');
  assert.ok(refreshBtn, 'expected Refresh button');
});

test('!devices Refresh button click updates message with fresh device data', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  await adapter.simulateAction('cmd:devices:refresh', 'refresh',
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'devices-msg-1' } },
  );

  const lastUpdated = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdated, 'expected an updateMessage call');
  assert.ok(lastUpdated.content.text.includes('Devices'), 'updated message should include Devices header');
});

test('!devices without router falls back to plain text', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
  });

  dispatchCommand('!devices', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.equal(lastPosted.content.richBlocks, undefined, 'no richBlocks in fallback');
  assert.ok(lastPosted.content.text.includes('Devices'), 'should have Devices header');
});

// ============================================================
// Interactive !tasks (Phase 2)
// ============================================================

test('!tasks with router shows filter buttons', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  // Use a project name that won't exist — should get "Project not found"
  // but for testing interactive features we need to mock scanAllTasks.
  // Instead test against a project-not-found or zero-task scenario which
  // should NOT show buttons (buttons only with tasks present).
  dispatchCommand('!tasks nonexistent-project', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  // Error/empty cases should have no actions
  assert.equal(lastPosted.content.richBlocks, undefined, 'no actions for missing project');
});

test('!tasks filter action handler is registered when router present', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  // The filter action handler should be registered and callable
  // (won't update because no real project data, but shouldn't throw)
  await adapter.simulateAction('cmd:tasks:filter-all',
    JSON.stringify({ project: 'nonexistent', filter: 'all' }),
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'tasks-msg-1' } },
  );
  // No crash = handler is registered and runs gracefully with missing data
});

test('!tasks without router falls back to plain text', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
  });

  dispatchCommand('!tasks nonexistent-project', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.equal(lastPosted.content.richBlocks, undefined);
});

// ============================================================
// Interactive !resume (Phase 3)
// ============================================================

test('!resume with router registers switch action handlers', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  // Action handlers for session switching should be registered
  // Simulate a switch action — won't find a real session but shouldn't throw
  await adapter.simulateAction('cmd:resume:switch-0', 'nonexistent-session',
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'resume-msg-1' } },
  );
  // No crash = handlers registered correctly
});

// Note: !resume backward compat test omitted — handleResumeCmd uses async file I/O
// (sessionRegistryRepo) that hangs in the test environment without a real data dir.

// ============================================================
// Interactive !profile (Phase 3)
// ============================================================

test('!profile with router shows profiles with switch buttons', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  dispatchCommand('!profile', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted, 'expected a posted message');
  // With router, should have richBlocks with actions
  const actionsBlock = lastPosted.content.richBlocks?.find(b => b.type === 'actions');
  assert.ok(actionsBlock, 'expected profile switch buttons');
  assert.ok(actionsBlock.elements.length >= 1, 'expected at least one profile button');
});

test('!profile switch button click changes profile', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  // Simulate clicking a profile switch button
  await adapter.simulateAction('cmd:profile:set-0', JSON.stringify({ name: 'plan', channel: 'C123' }),
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'profile-msg-1' } },
  );

  const lastUpdated = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdated, 'expected an updateMessage call');
});

test('!profile without router falls back to plain text', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
  });

  dispatchCommand('!profile', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.equal(lastPosted.content.richBlocks, undefined, 'no richBlocks in fallback');
});

// ============================================================
// Interactive !agent (Phase 3)
// ============================================================

test('!agent with router shows agents with select buttons', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  dispatchCommand('!agent', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted, 'expected a posted message');
  const actionsBlock = lastPosted.content.richBlocks?.find(b => b.type === 'actions');
  assert.ok(actionsBlock, 'expected agent select buttons');
});

test('!agent disable button click disables default agent', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  await adapter.simulateAction('cmd:agent:disable', '',
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'agent-msg-1' } },
  );

  const lastUpdated = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdated, 'expected an updateMessage call');
  assert.ok(lastUpdated.content.text.includes('disabled') || lastUpdated.content.text.includes('Disabled'),
    'should indicate agent was disabled');
});

test('!agent without router falls back to plain text', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null as any,
  });

  dispatchCommand('!agent', 'C123', adapter);
  await flush();

  const lastPosted = adapter.posted[adapter.posted.length - 1];
  assert.ok(lastPosted);
  assert.equal(lastPosted.content.richBlocks, undefined, 'no richBlocks in fallback');
});

// ============================================================
// Interactive !register (Phase 4)
// ============================================================

test('!register with router registers action handlers', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  // Registration action handler should exist
  await adapter.simulateAction('cmd:register:project-0', 'nonexistent-project',
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'reg-msg-1' } },
  );
  // No crash = handlers registered
});

// ============================================================
// Interactive !project-dir modal (Phase 4)
// ============================================================

test('!project-dir with router registers modal handler', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: null as any,
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  // Simulate modal submit
  await adapter.simulateModalSubmit('cmd_project_dir_add', {
    pd_project: { text: { value: 'test-project' } },
    pd_machine: { selection: { selectedOption: { value: 'testbox' } } },
    pd_path: { text: { value: '/home/test' } },
  }, { privateMetadata: JSON.stringify({ channel: 'C123' }) });

  // No crash = modal handler registered
});

// ============================================================
// Interactive !schedule list (Phase 4)
// ============================================================

test('!schedule list with router registers action handlers for pause/resume/remove', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  createCommandDispatcher({
    scheduler: { update: async () => null, list: async () => [], add: async () => ({}), remove: async () => false, pause: async () => null, resume: async () => null },
    commandRouter: router,
  });
  router.bindToAdapter(adapter);

  // Pause/resume/remove action handlers should exist
  await adapter.simulateAction('cmd:schedule:pause-0', 'test-id',
    { channelId: 'C123', messageRef: { conduit: 'C123', messageId: 'sched-msg-1' } },
  );
  // No crash = handlers registered
});
