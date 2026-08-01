// input:  Node test runner, command handlers, and auth fixture
// output: Bang-command routing including !login status
// pos:    Command handler regression test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { registerCommands as createCommandDispatcher } from '../src/orchestration/routing/commands/index.js';
import { handleBackendCmd } from '../src/orchestration/routing/commands/mode.js';
import { getActiveBackend, setActiveBackend } from '../src/domain/agents/config.js';
import { getDefaultProfileName } from '../src/domain/agents/profile-manager.js';
import { costRepo } from '../src/store/cost-repo.js';
import { MockAdapter } from '../src/platform/testing.js';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { _testSetRegistry } from '../src/domain/tasks/dispatch-utils.js';
import { runningExecutions } from '../src/core/running-executions.js';
import * as executionRegistry from '../src/domain/executions/registry.js';
import { conduitQueues } from '../src/orchestration/conduit-queue.js';
import { threadStore } from '../src/store/thread-repo.js';
import { getLocale, setLocale } from '../src/core/i18n.js';
import type { AuthStatusSnapshot } from '../src/domain/auth/auth-status.js';

beforeAll(() => {
  _testSetRegistry({ testbox: { cortexPath: '/tmp/test', gpuCount: 2 } });
});

const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;

function withFakeIntervals(t) {
  const intervals = [];
  let nextId = 1;
  global.setInterval = (((fn, _ms) => {
    const entry = { id: nextId++, fn };
    intervals.push(entry);
    return entry;
  }) as unknown) as typeof setInterval;
  global.clearInterval = ((handle) => {
    const idx = intervals.findIndex(entry => entry === handle || entry.id === handle);
    if (idx >= 0) intervals.splice(idx, 1);
  }) as typeof clearInterval;
  t.onTestFinished(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });
  return intervals;
}

function withMockedGpuExec(t, outputsByCommand) {
  const originalEnv = process.env.CORTEX_GPU_MONITOR_MOCK;
  process.env.CORTEX_GPU_MONITOR_MOCK = JSON.stringify(outputsByCommand);
  t.onTestFinished(() => {
    if (originalEnv === undefined) delete process.env.CORTEX_GPU_MONITOR_MOCK;
    else process.env.CORTEX_GPU_MONITOR_MOCK = originalEnv;
  });
}
function withTempCostData(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cost-'));
  const costFile = path.join(dir, 'costs.json');
  const budgetFile = path.join(dir, 'budget.json');
  fs.writeFileSync(costFile, entries.map((e: any) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(budgetFile, JSON.stringify({ daily_usd: 10, monthly_usd: 100 }, null, 2));
  process.env.CORTEX_COSTS_FILE = costFile;
  process.env.CORTEX_BUDGET_FILE = budgetFile;
  // Reset the lazy JsonRepository so it picks up the new CORTEX_COSTS_FILE/CORTEX_BUDGET_FILE paths.
  costRepo._testReset();
  t.onTestFinished(() => {
    delete process.env.CORTEX_COSTS_FILE;
    delete process.env.CORTEX_BUDGET_FILE;
    costRepo._testReset();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}


test('!backend selects PI and reports the live backend label', async (t) => {
  const previous = getActiveBackend();
  t.onTestFinished(() => setActiveBackend(previous));
  const adapter = new MockAdapter();

  await handleBackendCmd('C-backend', adapter, '!backend pi');

  assert.equal(getActiveBackend(), 'pi');
  assert.match(adapter.posted[0].content.text, /PI/);
});

test('!cost <project> filters report to the requested project scope', async (t) => {
  const now = new Date().toISOString();
  withTempCostData(t, [
    { timestamp: now, project: 'proj-a', trigger: 'user', cost_usd: 1.5, mode: 'api' },
    { timestamp: now, project: 'proj-b', trigger: 'dispatch', cost_usd: 2.0, mode: 'plan' },
  ]);

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  const handled = dispatchCommand('!cost proj-a', 'C123', adapter);
  assert.equal(handled, true);
  // formatCostReport is async (costRepo.readCosts reads JSONL file); wait with timeout.
  const deadline = Date.now() + 5_000;
  while (adapter.posted.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(adapter.posted.length, 1);
  assert.match(adapter.posted[0].content.text, /Cost Report \(project: proj-a\)/);
  assert.match(adapter.posted[0].content.text, /Today: \$1\.50/);
  assert.doesNotMatch(adapter.posted[0].content.text, /proj-b/);
});

test('!status reports running executions from injected registry summary', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    getExecutionStatusReport: () => [
      'Running executions: 2',
      '• local C1 proj-a running',
      '• dispatch lab:t123 proj-b running',
    ].join('\n'),
  });

  const handled = dispatchCommand('!status', 'C123', adapter);
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal((adapter.posted[0].destination as { conduit: string }).conduit, 'C123');
  assert.equal(adapter.posted[0].content.text, 'Running executions: 2\n• local C1 proj-a running\n• dispatch lab:t123 proj-b running');
});

const COMMAND_AUTH_SNAPSHOT: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [{
    backend: 'claude', provider: 'anthropic', label: 'Anthropic', capabilities: ['oauth'],
    authType: 'oauth', state: 'logged-in', source: 'credentials.json', expiresAt: null,
    refreshExpiresAt: null, inUse: true, credentials: [{
      authType: 'oauth', state: 'logged-in', source: 'credentials.json', expiresAt: null,
      refreshExpiresAt: null, manageable: true,
    }],
  }],
  piRuntime: { available: false, version: null, entry: null, error: 'pi executable not found' },
};

test('!login and !login status share the localized authentication summary and appear in help', async (t) => {
  const previousLocale = getLocale();
  t.onTestFinished(() => setLocale(previousLocale));
  setLocale('zh');
  let calls = 0;
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    getAuthStatus: async () => { calls += 1; return COMMAND_AUTH_SNAPSHOT; },
  });

  assert.equal(dispatchCommand('!login', 'C-auth', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatchCommand('!login status', 'C-auth', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatchCommand('!help', 'C-auth', adapter), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls, 2);
  assert.match(adapter.posted[0].content.text, /认证状态/);
  assert.equal(adapter.posted[1].content.text, adapter.posted[0].content.text);
  assert.match(adapter.posted[2].content.text, /!login/);
});

test('!login rejects unsupported arguments with localized usage', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    getAuthStatus: async () => COMMAND_AUTH_SNAPSHOT,
  });

  assert.equal(dispatchCommand('!login now', 'C-auth', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted[0].content.text, /!login \[status\]/);
});

test('!schedule add without --profile fixes task profile to defaultProfile', async () => {
  const adapter = new MockAdapter();
  const added = [];
  const scheduler = {
    add(type, options) {
      added.push({ type, options });
      return {
        id: 'abcd1234',
        type,
        intervalMs: options.intervalMs,
        message: options.message,
        channel: options.channel,
        profile: options.profile,
        nextRun: Date.now() + options.intervalMs,
      };
    },
    pause() { return null; },
    resume() { return null; },
    remove() { return false; },
    list() { return []; },
  };
  const dispatchCommand = createCommandDispatcher({
    scheduler,
  });

  assert.equal(dispatchCommand('!schedule add interval 30m test scheduled task', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'interval');
  assert.equal(added[0].options.profile, getDefaultProfileName());
  assert.match(adapter.posted[0].content.text, new RegExp(`profile: \\*${getDefaultProfileName()}\\*`));
});

test('!schedule add with --profile preserves explicit profile override', async () => {
  const adapter = new MockAdapter();
  const added = [];
  const scheduler = {
    add(type, options) {
      added.push({ type, options });
      return {
        id: 'abcd1234',
        type,
        intervalMs: options.intervalMs,
        message: options.message,
        channel: options.channel,
        profile: options.profile,
        nextRun: Date.now() + options.intervalMs,
      };
    },
    pause() { return null; },
    resume() { return null; },
    remove() { return false; },
    list() { return []; },
  };
  const dispatchCommand = createCommandDispatcher({
    scheduler,
  });

  assert.equal(dispatchCommand('!schedule add interval 30m --profile qa test scheduled task', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(added.length, 1);
  assert.equal(added[0].options.profile, 'qa');
  assert.match(adapter.posted[0].content.text, /profile: \*qa\*/);
});

test('!schedule pause/resume/remove accepts backtick-wrapped 8-char hex schedule ids', async () => {
  const adapter = new MockAdapter();
  const pausedIds = [];
  const resumedIds = [];
  const removedIds = [];
  const scheduler = {
    pause(id) {
      pausedIds.push(id);
      return { id, type: 'interval', intervalMs: 3600000, message: 'interval task', profile: null, isPaused: true, pausedAt: Date.now(), nextRun: null };
    },
    resume(id) {
      resumedIds.push(id);
      return { id, type: 'interval', intervalMs: 3600000, message: 'interval task', profile: null, isPaused: false, pausedAt: null, nextRun: Date.now() + 3600000 };
    },
    remove(id) {
      removedIds.push(id);
      return true;
    },
    list() { return []; },
  };
  const dispatchCommand = createCommandDispatcher({
    scheduler,
  });

  assert.equal(dispatchCommand('!schedule pause `c8d34e12`', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pausedIds, ['c8d34e12']);
  assert.match(adapter.posted[0].content.text, /Paused task `c8d34e12`/);

  assert.equal(dispatchCommand('!schedule resume `c8d34e12`', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(resumedIds, ['c8d34e12']);
  assert.match(adapter.posted[1].content.text, /Resumed task `c8d34e12`/);

  assert.equal(dispatchCommand('!schedule remove `c8d34e12`', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removedIds, ['c8d34e12']);
  assert.match(adapter.posted[2].content.text, /Removed task `c8d34e12`/);
});

test('!schedule pause/resume/remove accepts 8-char hex schedule ids', async () => {
  const adapter = new MockAdapter();
  const removedIds = [];
  const scheduler = {
    pause(id) {
      return { id, type: 'interval', intervalMs: 3600000, message: 'interval task', profile: null, isPaused: true, pausedAt: Date.now(), nextRun: null };
    },
    resume(id) {
      return { id, type: 'interval', intervalMs: 3600000, message: 'interval task', profile: null, isPaused: false, pausedAt: null, nextRun: Date.now() + 3600000 };
    },
    remove(id) {
      removedIds.push(id);
      return true;
    },
    list() { return []; },
  };
  const dispatchCommand = createCommandDispatcher({
    scheduler,
  });

  assert.equal(dispatchCommand('!schedule pause c8d34e12', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted[0].content.text, /Paused task `c8d34e12`/);

  assert.equal(dispatchCommand('!schedule resume c8d34e12', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted[1].content.text, /Resumed task `c8d34e12`/);

  assert.equal(dispatchCommand('!schedule remove c8d34e12', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removedIds, ['c8d34e12']);
  assert.match(adapter.posted[2].content.text, /Removed task `c8d34e12`/);
});

// existing tests

test('!cancel <taskId> cancels a dispatched task via injected handler', async () => {
  const adapter = new MockAdapter();
  const calls = [];
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    cancelDispatchedTask: async ({ taskId, channel }) => {
      calls.push({ taskId, channel });
      return { ok: true, message: 'cancelled abcd' };
    },
  });

  const handled = dispatchCommand('!cancel abcd', 'C123', adapter);
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, [{ taskId: 'abcd', channel: 'C123' }]);
  assert.equal((adapter.posted[0].destination as { conduit: string }).conduit, 'C123');
  assert.equal(adapter.posted[0].content.text, 'cancelled abcd');
});

test('plain !cancel still cancels the current active process', async (t) => {
  const adapter = new MockAdapter();
  let killed = false;
  runningExecutions.register({ threadId: null, channel: 'C123', agentSlotId: null, executionId: 'exec-conv1', kill: () => { killed = true; return true; }, backend: 'test' });
  // Simulate a running queue entry so cancel can clear it
  conduitQueues.set('C123', Promise.resolve());
  t.onTestFinished(() => { runningExecutions.remove('exec-conv1'); conduitQueues.delete('C123'); });
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    cancelDispatchedTask: async () => ({ ok: false, message: 'should not be called' }),
  });

  const handled = dispatchCommand('!cancel', 'C123', adapter);
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(killed, true);
  assert.equal(conduitQueues.has('C123'), false);
  assert.equal((adapter.posted[0].destination as { conduit: string }).conduit, 'C123');
  assert.equal(adapter.posted[0].content.text, '🛑 Cancelled. Session preserved — next message will resume.');
});

test('!cancel marks the execution record cancelled (not failed), idempotently', async (t) => {
  const adapter = new MockAdapter();
  const rec = executionRegistry.startLocalExecution({ channel: 'Ccancel', project: 'general', trigger: 'user', backend: 'test' });
  runningExecutions.register({ threadId: null, channel: 'Ccancel', agentSlotId: null, executionId: rec.id, kill: () => true, backend: 'test' });
  t.onTestFinished(() => { runningExecutions.remove(rec.id); });

  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    cancelDispatchedTask: async () => ({ ok: false, message: 'should not be called' }),
  });
  dispatchCommand('!cancel', 'Ccancel', adapter);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

  assert.equal(executionRegistry.getExecution(rec.id)!.status, 'cancelled', 'record must be cancelled, not running/failed');
  // The kill-error path would later call failExecution; it must NOT flip a terminal record.
  executionRegistry.failExecution(rec.id, { durationS: 1, error: 'killed' });
  assert.equal(executionRegistry.getExecution(rec.id)!.status, 'cancelled', 'cancelled record stays cancelled');
});

// ── !cancel --all ─────────────────────────────────────────────────────────

test('!cancel --all kills all running executions for current channel, spares other channels', async (t) => {
  const adapter = new MockAdapter();
  let killedC1 = false;
  let killedC2 = false;

  runningExecutions.register({ threadId: 'thr_11111111', channel: 'C1', agentSlotId: null, executionId: 'exec-1', kill: () => { killedC1 = true; return true; }, backend: 'test' });
  runningExecutions.register({ threadId: 'thr_22222222', channel: 'C2', agentSlotId: null, executionId: 'exec-2', kill: () => { killedC2 = true; return true; }, backend: 'test' });
  conduitQueues.set('C1', Promise.resolve());
  t.onTestFinished(() => { runningExecutions.remove('exec-1'); runningExecutions.remove('exec-2'); conduitQueues.delete('C1'); });

  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  const handled = dispatchCommand('!cancel --all', 'C1', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

  assert.equal(killedC1, true, 'execution in current channel should be killed');
  assert.equal(killedC2, false, 'execution in different channel should NOT be killed');
  assert.equal(conduitQueues.has('C1'), false);
  assert.match(adapter.posted[0].content.text, /Cancelled 1 execution/);
});

test('!cancel --all with nothing running shows "Nothing running"', async (t) => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  const handled = dispatchCommand('!cancel --all', 'C1', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.match(adapter.posted[0].content.text, /Nothing running/);
});

// ── !cancel <threadId> ─────────────────────────────────────────────────────

test('!cancel <threadId> kills by threadId', async (t) => {
  const adapter = new MockAdapter();
  let killed = false;

  runningExecutions.register({ threadId: 'thr_a1b2c3d4', channel: 'C1', agentSlotId: null, executionId: 'exec-1', kill: () => { killed = true; return true; }, backend: 'test' });
  t.onTestFinished(() => { runningExecutions.remove('exec-1'); });

  const dispatchCommand = createCommandDispatcher({ scheduler: null, cancelDispatchedTask: null });
  const handled = dispatchCommand('!cancel thr_a1b2c3d4', 'C1', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

  assert.equal(killed, true);
  assert.match(adapter.posted[0].content.text, /thr_a1b2c3d4.*cancelled/i);
  assert.equal(runningExecutions.getByThreadId('thr_a1b2c3d4'), null);
});

test('!cancel <threadId> with unknown threadId shows not found', async (t) => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null, cancelDispatchedTask: null });
  const handled = dispatchCommand('!cancel thr_ffffffff', 'C1', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.match(adapter.posted[0].content.text, /no running thread|not found/i);
});

test('!cancel <threadId> with non-thread-id arg falls back to taskId dispatch', async (t) => {
  const adapter = new MockAdapter();
  const calls: { taskId: string; channel: string }[] = [];
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    cancelDispatchedTask: async ({ taskId, channel }) => {
      calls.push({ taskId, channel });
      return { ok: true, message: 'cancelled abcd' };
    },
  });
  const handled = dispatchCommand('!cancel abcd', 'C1', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [{ taskId: 'abcd', channel: 'C1' }]);
});

// ── !thread cancel alias ───────────────────────────────────────────────────

test('!thread cancel is alias for !cancel (kills by channel)', async (t) => {
  const adapter = new MockAdapter();
  let killed = false;
  runningExecutions.register({ threadId: null, channel: 'C123', agentSlotId: null, executionId: 'exec-conv2', kill: () => { killed = true; return true; }, backend: 'test' });
  conduitQueues.set('C123', Promise.resolve());
  t.onTestFinished(() => { runningExecutions.remove('exec-conv2'); conduitQueues.delete('C123'); });

  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  const handled = dispatchCommand('!thread cancel', 'C123', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

  assert.equal(killed, true);
  assert.equal(conduitQueues.has('C123'), false);
  assert.match(adapter.posted[0].content.text, /Cancelled|cancel/i);
});

test('!thread cancel with nothing running shows "Nothing running"', async (t) => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  const handled = dispatchCommand('!thread cancel', 'C123', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.match(adapter.posted[0].content.text, /Nothing running/);
});

// ── !thread list --running ─────────────────────────────────────────────────

test('!thread list --running shows running threads across channels', async (t) => {
  const adapter = new MockAdapter();
  runningExecutions.register({ threadId: 'thr_a1111111', channel: 'C1', agentSlotId: null, executionId: 'exec-1', kill: () => true, backend: 'test' });
  runningExecutions.register({ threadId: 'thr_b2222222', channel: 'C2', agentSlotId: null, executionId: 'exec-2', kill: () => true, backend: 'pi' });
  t.onTestFinished(() => { runningExecutions.remove('exec-1'); runningExecutions.remove('exec-2'); });

  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  const handled = dispatchCommand('!thread list --running', 'C1', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

  const text = adapter.posted[0].content.text;
  assert.match(text, /thr_a1111111/);
  assert.match(text, /thr_b2222222/);
  assert.match(text, /C1/);
  assert.match(text, /C2/);
});

test('!thread list --running with no running threads shows empty message', async (t) => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  const handled = dispatchCommand('!thread list --running', 'C1', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.match(adapter.posted[0].content.text, /no running/i);
});

test('!thread list still shows recent threads (existing behavior preserved)', async (t) => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  const handled = dispatchCommand('!thread list', 'C1', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.match(adapter.posted[0].content.text, /Recent Threads|No threads/);
});

test('!nvtop starts live GPU monitor with sparkline view and updates the same message', async (t) => {
  const intervals = withFakeIntervals(t);
  withMockedGpuExec(t, {
    GPU: [
      '0, GPU-0, RTX 6000 Ada, 92, 18342, 49140, 67, 241\n1, GPU-1, RTX 6000 Ada, 3, 210, 49140, 41, 28',
      '0, GPU-0, RTX 6000 Ada, 75, 16000, 49140, 63, 220\n1, GPU-1, RTX 6000 Ada, 12, 512, 49140, 43, 35',
    ],
    PROC: [
      '318421, python train.py, 17980, GPU-0',
      '318421, python train.py, 15000, GPU-0\n4521, python eval.py, 256, GPU-1',
    ],
  });

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  assert.equal(dispatchCommand('!nvtop testbox', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(adapter.posted.length, 1);
  const firstText = adapter.posted[0].content.text;
  assert.match(firstText, /testbox/);
  assert.match(firstText, /GPU0/);
  assert.match(firstText, /Util \[/);
  assert.match(firstText, /Spark .*▁|Spark .*▂|Spark .*▃|Spark .*▄|Spark .*▅|Spark .*▆|Spark .*▇|Spark .*█/);
  assert.equal(intervals.length, 1);
  assert.match(firstText, /refresh 1s/);

  await intervals[0].fn();

  assert.equal(adapter.updated.length, 1);
  assert.match(adapter.updated[0].content.text, /eval\.py/);
  assert.match(adapter.updated[0].content.text, /75%/);
});

test('!nvtop stop stops active monitor and reports when none is running', async (t) => {
  const intervals = withFakeIntervals(t);
  withMockedGpuExec(t, {
    GPU: ['0, GPU-0, RTX 6000 Ada, 50, 12000, 49140, 55, 180'],
    PROC: ['123, python train.py, 11000, GPU-0'],
  });

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  dispatchCommand('!nvtop testbox', 'CSTOP', adapter);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(intervals.length, 1);

  dispatchCommand('!nvtop stop', 'CSTOP', adapter);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(intervals.length, 0);
  assert.match(adapter.posted.at(-1).content.text, /stopped/i);

  dispatchCommand('!nvtop stop', 'CSTOP', adapter);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted.at(-1).content.text, /No active nvtop/i);
});

test('!nvtop rejects unsupported machines', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  assert.equal(dispatchCommand('!nvtop my-pc', 'C999', adapter), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.match(adapter.posted[0].content.text, /not supported|no gpu|unsupported|unknown machine/i);
});


let taskCmdProjSeq = 0;
function withTempTasksProject(t) {
  const project = `_test_tcmd_${++taskCmdProjSeq}`;
  const projectDir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(projectDir, { recursive: true });
  const tasksPath = path.join(projectDir, 'TASKS.yaml');
  fs.writeFileSync(tasksPath, [
    'tasks:',
    '  - id: ab12',
    '    text: "Build sensor module"',
    '    why: "Need haptic feedback for grasping"',
    '    done-when: "sensor data streams at 100Hz"',
    '    priority: high',
    '    status: open',
    '    template: coder-review',
    '    plan: ""',
    '',
    '  - id: cd34',
    '    text: "Write data loader"',
    '    why: "Training pipeline needs data"',
    '    done-when: "loader handles all formats"',
    '    priority: medium',
    '    status: done',
    '    template: coder-review',
    '    plan: ""',
    '',
    '  - id: ef56',
    '    text: "Design reward function"',
    '    why: "RL training requires shaped reward"',
    '    done-when: "reward correlates with task success > 0.8"',
    '    priority: high',
    '    status: open',
    '    template: coder-review',
    '    plan: ""',
    '    blocked-by: "waiting for sim"',
  ].join('\n'));
  t.onTestFinished(() => {
    try { fs.unlinkSync(tasksPath); } catch {}
    try { fs.rmdirSync(projectDir); } catch {}
  });
  return { project, projectDir };
}

test('!tasks without project name shows usage error', async (t) => {
  const { project } = withTempTasksProject(t);
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  const handled = dispatchCommand('!tasks', 'C123', adapter);
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(adapter.posted.length, 1);
  assert.match(adapter.posted[0].content.text, /Usage.*!tasks <project>/);
});

test('!tasks with unknown project shows error', async (t) => {
  const { project } = withTempTasksProject(t);
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  const handled = dispatchCommand('!tasks no-such-proj', 'C123', adapter);
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(adapter.posted.length, 1);
  assert.match(adapter.posted[0].content.text, /no-such-proj/);
  assert.match(adapter.posted[0].content.text, /No tasks found|not found|unknown/i);
});

test('!tasks <project> lists all tasks with details', async (t) => {
  const { project } = withTempTasksProject(t);
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  const handled = dispatchCommand(`!tasks ${project}`, 'C123', adapter);
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(adapter.posted.length, 1);
  const text = adapter.posted[0].content.text;
  // Header
  assert.match(text, new RegExp(project));
  // All 3 tasks present
  assert.match(text, /ab12/);
  assert.match(text, /cd34/);
  assert.match(text, /ef56/);
  // Task details
  assert.match(text, /Build sensor module/);
  assert.match(text, /Write data loader/);
  assert.match(text, /Design reward function/);
  // Status indicators: completed task should show differently
  assert.match(text, /high/i);
  // Blocked task indicator
  assert.match(text, /blocked/i);
});

// --- !dispatch command ---

function makeDispatchThreadRecord(id: string, channel: string, overrides: Record<string, any> = {}): any {
  const now = new Date().toISOString();
  return {
    id, channel,
    projectId: 'test-proj',
    templateName: null,
    status: 'running',
    platformThreadId: null,
    userMessage: 'dispatch task',
    userMessageTs: '111.000',
    workspacePath: '',
    artifactPath: '',
    agents: { main: { slotId: 'main', profile: '__active__', sessionId: null, sessionName: null, status: 'idle', lastOutput: null, persistSession: false } },
    activeAgent: 'main',
    activeStage: null,
    currentStepIndex: 0,
    steps: [],
    iterationCounts: {},
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    error: null,
    abortReason: null,
    metadata: { trigger: 'task-dispatch', scheduleTaskId: 'sched-1', project: 'test-proj', profileOverride: 'default' },
    ...overrides,
  };
}

test('!compact is exact and delegates to the shared channel coordinator', async () => {
  const adapter = new MockAdapter();
  const calls: string[] = [];
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    compactSessionByChannel: async ({ channel }) => {
      calls.push(channel);
      return { ok: true, status: 'compacted', contextUsage: null };
    },
  });
  assert.equal(dispatchCommand('!compact', 'Ccompact', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['Ccompact']);
  assert.match(adapter.posted[0].content.text, /context compacted/i);

  assert.equal(dispatchCommand('!compact now', 'Ccompact', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['Ccompact'], 'arguments must not prefix-match the exact command');
  assert.match(adapter.posted[1].content.text, /unknown command/i);
});

test('!compact reports busy and !help advertises the exact command', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    compactSessionByChannel: async () => ({ ok: false, reason: 'running' }),
  });
  dispatchCommand('!compact', 'Ccompact-busy', adapter);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted[0].content.text, /stop.*before compacting|running/i);

  dispatchCommand('!help', 'Ccompact-busy', adapter);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted[1].content.text, /!compact/);
});

test('!dispatch --profile updates profileOverride on running dispatch thread', async (t) => {
  const threadId = threadStore.generateId();
  const thread = makeDispatchThreadRecord(threadId, 'C123');
  await threadStore.set(thread);
  t.onTestFinished(() => threadStore.delete(threadId).catch(() => {}));

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });

  const handled = dispatchCommand(`!dispatch ${threadId} --profile execute`, 'C123', adapter);
  assert.equal(handled, true);
  // Drain microtask queue: dispatchCommand is fire-and-forget via catchHandlerError,
  // and threadStore.mutate inside the handler awaits the persist queue.
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }

  const updated = threadStore.get(threadId);
  assert.equal(updated?.metadata?.profileOverride, 'execute');
});

test('!dispatch without args shows usage', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });

  const handled = dispatchCommand('!dispatch', 'C123', adapter);
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(adapter.posted.length, 1);
  assert.match(adapter.posted[0].content.text, /usage|Usage|!dispatch/i);
});

test('!dispatch on non-existent thread shows error', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });

  const handled = dispatchCommand('!dispatch thr_nonexistent --profile execute', 'C123', adapter);
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.match(adapter.posted[0].content.text, /not found|error|Error|unknown/i);
});

test('!dispatch with invalid profile name shows error', async (t) => {
  const threadId = threadStore.generateId();
  const thread = makeDispatchThreadRecord(threadId, 'C123');
  await threadStore.set(thread);
  t.onTestFinished(() => threadStore.delete(threadId).catch(() => {}));

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });

  const handled = dispatchCommand(`!dispatch ${threadId} --profile nonexistent_profile`, 'C123', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.match(adapter.posted[0].content.text, /unknown|not found|error/i);
});

test('!dispatch on completed thread shows warning', async (t) => {
  const threadId = threadStore.generateId();
  const thread = makeDispatchThreadRecord(threadId, 'C123', { status: 'completed' });
  await threadStore.set(thread);
  t.onTestFinished(() => threadStore.delete(threadId).catch(() => {}));

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });

  const handled = dispatchCommand(`!dispatch ${threadId} --profile execute`, 'C123', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.match(adapter.posted[0].content.text, /warning|completed/i);
});

test('!dispatch on non-dispatch thread shows error', async (t) => {
  const threadId = threadStore.generateId();
  const thread = makeDispatchThreadRecord(threadId, 'C123', { metadata: { trigger: 'scheduled' } });
  await threadStore.set(thread);
  t.onTestFinished(() => threadStore.delete(threadId).catch(() => {}));

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });

  const handled = dispatchCommand(`!dispatch ${threadId} --profile execute`, 'C123', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.match(adapter.posted[0].content.text, /not a dispatch thread|is not/i);
});
