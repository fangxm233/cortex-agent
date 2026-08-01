// input:  orchestrator, injected runtime, fake agents/supervisors
// output: C9 shape, scoped cancellation and durable ordering
// pos:    Benchmark local-thread lifecycle contract tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  attachOptions: [] as any[],
  lifecycle: [] as string[],
  manifestMode: 'normal' as 'normal' | 'omit' | 'wrong_linkage',
  runAgent: vi.fn(),
  supervisors: [] as any[],
}));

vi.mock('../../../src/domain/agents/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runAgent: harness.runAgent,
  getClaudeMode: () => 'api',
  closeSessionsByPrefix: () => {},
}));

vi.mock('../../../src/domain/agent-run/supervisor.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  attachSupervisor: (options: unknown) => {
    harness.attachOptions.push(options);
    const session = harness.supervisors.shift();
    if (!session) throw new Error('Missing fake supervisor');
    return session;
  },
}));

vi.mock('../../../src/domain/agent-run/journal.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    openJournal: (options: unknown) => wrapJournal(actual.openJournal(options)),
  };
});

vi.mock('../../../src/domain/agent-run/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    writeTerminalManifest: (input: any) => {
      if (harness.manifestMode === 'omit') {
        return actual.resolveLifecyclePaths(input).terminal;
      }
      const result = actual.writeTerminalManifest(input);
      if (harness.manifestMode === 'wrong_linkage') {
        const record = JSON.parse(fs.readFileSync(result, 'utf8'));
        fs.writeFileSync(result, JSON.stringify({ ...record, journal_path: `${record.journal_path}.wrong` }));
      }
      harness.lifecycle.push('manifest_committed');
      return result;
    },
  };
});

import { CONFIG_DIR, STORE_DIR } from '../../../src/core/paths.js';
import { RunningExecutions, runningExecutions as daemonRunningExecutions } from '../../../src/core/running-executions.js';
import type { AgentResult } from '../../../src/core/types/agent-types.js';
import type { RunAgentOptions } from '../../../src/domain/agents/facade.js';
import * as executionRegistry from '../../../src/domain/executions/registry.js';
import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import { cancelThread as daemonCancelThread } from '../../../src/domain/threads/index.js';
import { runThread as daemonRunThread } from '../../../src/domain/threads/runner.js';
import {
  openJournal,
} from '../../../src/domain/agent-run/journal.js';
import {
  resolveLifecyclePaths,
  validateTrajectoryLifecycle,
  validateTrajectoryRoot,
  writeStartedMarker,
  writeTerminalManifest,
} from '../../../src/domain/agent-run/manifest.js';
import { profileRepo } from '../../../src/store/profile-repo.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface FakeSupervisor {
  process: any;
  started: Promise<{ pid: number; pgid: number }>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  quiescent: Promise<void>;
  closed: Promise<{ code: number | null; signal: null }>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-local-thread-'));
const FORBIDDEN_SUBSYSTEMS = [
  'profile watcher', 'template watcher', 'settings runtime', 'memory watcher',
  'gateway', 'client manager', 'scheduler', 'webhook', 'claim startup recovery',
  'thread startup recovery', 'injection startup recovery', 'rate-limit resume dispatcher',
];
const forbiddenSpies: Array<{ mock: { calls: unknown[][] }; mockRestore(): void }> = [];

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function wrapJournal(journal: any): any {
  return {
    path: journal.path,
    header: journal.header,
    get eventCount() { return journal.eventCount; },
    writeEvent: (input: unknown) => journal.writeEvent(input),
    sha256: () => journal.sha256(),
    close: async () => {
      await journal.close();
      harness.lifecycle.push('journal_closed');
    },
  };
}

function fakeSupervisor(quiescent: Promise<void> = Promise.resolve()): FakeSupervisor {
  const cancel = vi.fn();
  const trackedQuiescence = quiescent.then(() => { harness.lifecycle.push('supervisor_quiescent'); });
  void trackedQuiescence.catch(() => {});
  return {
    process: {},
    started: Promise.resolve({ pid: 101, pgid: 101 }),
    exited: Promise.resolve({ code: 0, signal: null }),
    quiescent: trackedQuiescence,
    closed: Promise.resolve({ code: 0, signal: null }),
    cancel,
    dispose: vi.fn(async () => {}),
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function seedProfiles(): void {
  writeJson(path.join(CONFIG_DIR, 'profiles.json'), {
    defaultProfile: 'benchmark-fixture',
    profiles: {
      'benchmark-fixture': {
        model: 'fixture-model', backend: 'claude', claudeBackend: 'print',
        provider: 'anthropic', fallback: [],
      },
    },
  });
  profileRepo.invalidate();
}

function benchmarkAgent(name: string): Record<string, unknown> {
  return {
    name, profile: '__active__', persistSession: false,
    directive: `${name} directive`, systemPrompt: `${name} system`,
    promptTemplate: 'Complete {{input}}', tools: 'Read,Write', pluginDirs: [],
  };
}

function seedTemplates(): void {
  const base = path.join(CONFIG_DIR, 'thread-templates');
  writeJson(path.join(base, 'agents', 'benchmark-coder.json'), benchmarkAgent('benchmark-coder'));
  writeJson(path.join(base, 'agents', 'benchmark-reviewer.json'), benchmarkAgent('benchmark-reviewer'));
  writeJson(path.join(base, 'templates', 'fixture-one-step.json'), {
    name: 'fixture-one-step', description: 'fixture', agents: ['benchmark-coder'],
    transitions: [], entryAgent: 'benchmark-coder', maxTotalSteps: 1, disableHooks: true,
  });
  writeJson(path.join(base, 'templates', 'fixture-two-step.json'), {
    name: 'fixture-two-step', description: 'fixture',
    agents: ['benchmark-coder', 'benchmark-reviewer'],
    transitions: [{ from: 'benchmark-coder', to: 'benchmark-reviewer', condition: { type: 'always' } }],
    entryAgent: 'benchmark-coder', maxTotalSteps: 2, disableHooks: true,
  });
  fs.mkdirSync(path.join(base, 'shells'), { recursive: true });
}

function result(output: string, cost = 0.25): AgentResult {
  return {
    sessionId: 'fixture-session', finalOutput: output,
    total_cost_usd: cost, num_turns: 1, rateLimited: false,
    rateLimitMessage: null, planFilePath: null,
    enteredPlanMode: false, exitedPlanMode: false,
  };
}

function spawnThrough(options: RunAgentOptions): void {
  options.processSpawner!(process.execPath, ['-e', ''], {
    cwd: options.cwd,
    env: process.env,
  });
}

function queueSuccess(output: string, cost = 0.25): void {
  harness.supervisors.push(fakeSupervisor());
  harness.runAgent.mockImplementationOnce((_prompt: string, options: RunAgentOptions) => {
    spawnThrough(options);
    options.onAssistantMessage?.(output);
    return {
      promise: Promise.resolve(result(output, cost)),
      kill: () => true,
      sessionId: 'fixture-session',
    };
  });
}

function request(
  trajectoryRoot: string,
  signal: AbortSignal,
  overrides: Record<string, unknown> = {},
): any {
  const workspaceCwd = path.join(root, 'workspace');
  fs.mkdirSync(workspaceCwd, { recursive: true });
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  return {
    workspaceCwd, template: 'fixture-one-step', instruction: 'fix the fixture',
    profileName: 'benchmark-fixture', rootRunId: `run-${path.basename(trajectoryRoot)}`,
    trajectoryRoot,
    limits: { maxSteps: 2, maxCostUsd: 1, deadlineEpochMs: Date.now() + 30_000 },
    signal, ...overrides,
  };
}

function records(file: string): any[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

function assertC2(resultValue: any): void {
  const journal = records(resultValue.journalPath);
  assert.equal(journal[0].type, 'run_header');
  assert.equal(journal[0].seq, 0);
  assert.equal(journal[0].thread_id, resultValue.threadId);
  assert.equal(journal[0].agent_slot, 'benchmark-coder');
  assert.deepEqual(journal.map(row => row.seq), journal.map((_, index) => index));
  for (const row of journal.slice(1)) {
    assert.ok(['benchmark-coder', 'benchmark-reviewer'].includes(row.agent_slot));
    assert.ok(Object.hasOwn(row, 'reported_model'));
    assert.ok(Object.hasOwn(row, 'provider'));
  }
}

function assertCompletedResult(value: any): void {
  assert.equal(value.state, 'completed');
  assert.equal(value.terminalReason, null);
  assert.equal(value.steps, 1);
  assert.equal(value.costUsd, 0.25);
  assert.equal(value.summary, `${'x'.repeat(1966)}😀… [truncated, 1967 of 2100 chars]`);
  assert.equal(Array.from(value.summary).length, 2000);
}

async function moduleUnderTest(): Promise<any> {
  return import('../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js');
}

async function loadForbiddenModules(): Promise<any[]> {
  return Promise.all([
    import('../../../src/store/profile-repo.js'),
    import('../../../src/domain/threads/template-loader.js'),
    import('../../../src/core/settings.js'),
    import('../../../src/domain/memory/watcher.js'),
    import('../../../src/domain/costs/gateway-manager.js'),
    import('../../../src/domain/remote/client-manager.js'),
    import('../../../src/domain/scheduling/scheduler.js'),
    import('../../../src/orchestration/routing/webhook.js'),
    import('../../../src/domain/tasks/claim-recovery.js'),
    import('../../../src/orchestration/thread-callback.js'),
    import('../../../src/orchestration/pending-injection-recovery.js'),
    import('../../../src/orchestration/resume-dispatcher.js'),
  ]);
}

function registerForbiddenSpies(modules: any[]): void {
  const [profiles, templates, settings, memory, gateway, client, scheduler,
    webhook, claims, waiting, pending, resume] = modules;
  forbiddenSpies.push(
    vi.spyOn(profiles, 'startProfileWatcher'), vi.spyOn(templates, 'startConfigWatcher'),
    vi.spyOn(settings, 'getSettings'), vi.spyOn(memory, 'startMemoryWatcher'),
    vi.spyOn(gateway, 'startGateway'), vi.spyOn(client, 'startClientManager'),
    vi.spyOn(scheduler.Scheduler.prototype, 'start'), vi.spyOn(webhook, 'startWebhookServer'),
    vi.spyOn(claims, 'recoverOrphanedClaims'), vi.spyOn(waiting, 'recoverWaitingThreads'),
    vi.spyOn(pending, 'recoverPendingInjections'), vi.spyOn(resume, 'dispatchPendingResumes'),
  );
}

async function installForbiddenSpies(): Promise<void> {
  registerForbiddenSpies(await loadForbiddenModules());
}

beforeAll(async () => {
  seedProfiles();
  seedTemplates();
  await installForbiddenSpies();
}, 60_000);

beforeEach(() => {
  harness.attachOptions.length = 0;
  harness.lifecycle.length = 0;
  harness.manifestMode = 'normal';
  harness.runAgent.mockReset();
  harness.supervisors.length = 0;
  jobCtx.bus = null;
});

afterEach(() => {
  for (const [index, spy] of forbiddenSpies.entries()) {
    assert.equal(spy.mock.calls.length, 0, `${FORBIDDEN_SUBSYSTEMS[index]} must stay stopped`);
  }
});

afterAll(() => {
  for (const spy of forbiddenSpies) spy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

it('exports exactly C9 and completes one bounded thread with C2/C3 artifacts', async () => {
  const output = `\r\n ${'x'.repeat(1966)}😀${'y'.repeat(133)} \r`;
  queueSuccess(output);
  const api = await moduleUnderTest();
  assert.deepEqual(Object.keys(api), ['runBenchmarkThread']);
  const publish = vi.fn();
  const daemonBus = { publish } as any;
  jobCtx.bus = daemonBus;
  const req = request(path.join(root, 'success'), new AbortController().signal);

  const value = await api.runBenchmarkThread(req);

  assert.deepEqual(Object.keys(value).sort(), [
    'artifactPath', 'costUsd', 'durationMs', 'journalPath', 'manifestPath',
    'state', 'steps', 'summary', 'terminalReason', 'threadId',
  ].sort());
  assertCompletedResult(value);
  assert.equal(jobCtx.bus, daemonBus);
  assert.equal(publish.mock.calls.length, 0);
  assertC2(value);
  assert.deepEqual(validateTrajectoryRoot(req.trajectoryRoot), { ok: true, problems: [] });
  assert.deepEqual(harness.lifecycle.slice(-3), [
    'supervisor_quiescent', 'journal_closed', 'manifest_committed',
  ]);
  assert.equal(harness.attachOptions.length, 1);
  assert.equal(fs.existsSync(path.join(STORE_DIR, 'conversation-history')), false);
});

it('uses the landed lifecycle modules rather than a forked writer surface', async () => {
  assert.equal(typeof openJournal, 'function');
  assert.equal(typeof resolveLifecyclePaths, 'function');
  assert.equal(typeof writeStartedMarker, 'function');
  assert.equal(typeof writeTerminalManifest, 'function');
  assert.equal(typeof validateTrajectoryLifecycle, 'function');
  assert.equal(typeof validateTrajectoryRoot, 'function');
});

it('tears down local executions without the daemon execution registry', async () => {
  const start = vi.spyOn(executionRegistry, 'startLocalExecution');
  const teardown = vi.spyOn(executionRegistry, 'teardownExecution');
  queueSuccess('local execution');
  const req = request(path.join(root, 'local-ledger'), new AbortController().signal);
  try {
    const value = await (await moduleUnderTest()).runBenchmarkThread(req);
    assert.equal(value.state, 'completed');
    assert.equal(start.mock.calls.length, 0);
    assert.equal(teardown.mock.calls.length, 0);
  } finally {
    start.mockRestore();
    teardown.mockRestore();
  }
});

it('keeps local live-execution events off the daemon event bus', async () => {
  const publish = vi.fn();
  daemonRunningExecutions.setBus({ publish } as any);
  queueSuccess('isolated live execution');
  const req = request(path.join(root, 'local-live-ledger'), new AbortController().signal);
  try {
    const value = await (await moduleUnderTest()).runBenchmarkThread(req);
    assert.equal(value.state, 'completed');
    assert.equal(publish.mock.calls.length, 0);
  } finally {
    daemonRunningExecutions.setBus(null as any);
  }
});

it('runs the thread through the injected runtime operation', async () => {
  const runThread = vi.fn((...args: Parameters<typeof daemonRunThread>) => daemonRunThread(...args));
  queueSuccess('injected run operation');
  const req = request(path.join(root, 'injected-run'), new AbortController().signal);

  const value = await (await moduleUnderTest()).runBenchmarkThread(req, { runThread } as any);

  assert.equal(value.state, 'completed');
  assert.equal(runThread.mock.calls.length, 1);
});

function queueCancelableAgent(quiescence: Deferred<void>): FakeSupervisor {
  const agent = deferred<AgentResult>();
  const supervisor = fakeSupervisor(quiescence.promise);
  harness.supervisors.push(supervisor);
  harness.runAgent.mockImplementationOnce((_prompt: string, options: RunAgentOptions) => {
    spawnThrough(options);
    return {
      promise: agent.promise,
      kill: () => { agent.reject(new Error('cancelled')); return true; },
      sessionId: 'cancel-session',
    };
  });
  return supervisor;
}

function terminalExists(trajectoryRoot: string): boolean {
  try { return fs.readdirSync(trajectoryRoot).some(name => name.endsWith('.terminal.json')); }
  catch { return false; }
}

function monitorTerminal(trajectoryRoot: string) {
  let seen = false;
  const timer = setInterval(() => { seen ||= terminalExists(trajectoryRoot); }, 1);
  return { seen: () => seen, stop: () => clearInterval(timer) };
}

function assertCancelledResult(value: any): void {
  assert.equal(value.state, 'cancelled');
  assert.equal(value.terminalReason, 'cancelled');
  assert.equal(JSON.parse(fs.readFileSync(value.manifestPath, 'utf8')).state, 'cancelled');
  assert.deepEqual(harness.lifecycle.slice(-3), [
    'supervisor_quiescent', 'journal_closed', 'manifest_committed',
  ]);
}

it('cancel closes admission, waits for delayed quiescence, then closes and commits', async () => {
  const quiescence = deferred<void>();
  const supervisor = queueCancelableAgent(quiescence);
  const controller = new AbortController();
  const req = request(path.join(root, 'cancel'), controller.signal, { template: 'fixture-two-step' });
  const api = await moduleUnderTest();
  const monitor = monitorTerminal(req.trajectoryRoot);
  let settled = false;
  const pending = api.runBenchmarkThread(req).finally(() => { settled = true; });
  await vi.waitFor(() => assert.equal(harness.runAgent.mock.calls.length, 1));
  controller.abort();
  await vi.waitFor(() => assert.equal(supervisor.cancel.mock.calls.length, 1));
  assert.equal(terminalExists(req.trajectoryRoot), false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(harness.runAgent.mock.calls.length, 1);
  assert.equal(terminalExists(req.trajectoryRoot), false);
  monitor.stop();
  assert.equal(monitor.seen(), false);
  quiescence.resolve();
  assertCancelledResult(await pending);
});

it('keeps external abort on injected cancellation and waits for it before commit', async () => {
  const cancellation = deferred<void>();
  const quiescence = deferred<void>();
  queueCancelableAgent(quiescence);
  const cancelThread = vi.fn(async (threadId: string) => {
    const cancelled = await daemonCancelThread(threadId);
    await cancellation.promise;
    return cancelled;
  });
  const controller = new AbortController();
  const req = request(path.join(root, 'injected-cancel'), controller.signal);
  let settled = false;
  const pending = (await moduleUnderTest()).runBenchmarkThread(
    req,
    { cancelThread } as any,
  ).finally(() => { settled = true; });
  await vi.waitFor(() => assert.equal(harness.runAgent.mock.calls.length, 1));

  controller.abort();

  await vi.waitFor(() => assert.equal(cancelThread.mock.calls.length, 1));
  quiescence.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(terminalExists(req.trajectoryRoot), false);
  assert.equal(harness.lifecycle.includes('journal_closed'), false);
  cancellation.resolve();
  assertCancelledResult(await pending);
});

it('does not close or publish when supervisor quiescence is rejected', async () => {
  const quiescence = deferred<void>();
  queueSuccess('unsafe');
  harness.supervisors[0] = fakeSupervisor(quiescence.promise);
  setTimeout(() => quiescence.reject(new Error('containment failed')), 20);
  const req = request(path.join(root, 'containment-failed'), new AbortController().signal);
  const value = await (await moduleUnderTest()).runBenchmarkThread(req);
  assert.equal(value.state, 'failed');
  assert.equal(value.terminalReason, 'protocol_violation');
  assert.equal(fs.existsSync(value.manifestPath), false);
  assert.equal(harness.lifecycle.includes('journal_closed'), false);
  assert.equal(harness.lifecycle.includes('manifest_committed'), false);
});

it('does not treat ThreadRecord completed as success before external truth is durable', async () => {
  const quiescence = deferred<void>();
  harness.supervisors.push(fakeSupervisor(quiescence.promise));
  harness.runAgent.mockImplementationOnce((_prompt: string, options: RunAgentOptions) => {
    spawnThrough(options);
    return { promise: Promise.resolve(result('done')), kill: () => true, sessionId: 'done' };
  });
  const req = request(path.join(root, 'completed-not-durable'), new AbortController().signal);
  const api = await moduleUnderTest();
  let settled = false;
  const pending = api.runBenchmarkThread(req).finally(() => { settled = true; });
  await vi.waitFor(() => assert.equal(harness.runAgent.mock.calls.length, 1));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(fs.readdirSync(req.trajectoryRoot).some(name => name.endsWith('.terminal.json')), false);
  quiescence.resolve();
  assert.equal((await pending).state, 'completed');
});

it('surfaces started-without-terminal as failed even when the local runner completed', async () => {
  harness.manifestMode = 'omit';
  queueSuccess('done');
  const req = request(path.join(root, 'missing-terminal'), new AbortController().signal);
  const api = await moduleUnderTest();

  const value = await api.runBenchmarkThread(req);

  assert.equal(value.state, 'failed');
  assert.equal(value.terminalReason, 'protocol_violation');
  assert.equal(fs.existsSync(value.manifestPath), false);
  assert.match(validateTrajectoryRoot(req.trajectoryRoot).problems.join('\n'), /started_without_terminal/);
});

it('fails a terminal manifest whose envelope is valid but journal linkage is wrong', async () => {
  harness.manifestMode = 'wrong_linkage';
  queueSuccess('done');
  const req = request(path.join(root, 'wrong-linkage'), new AbortController().signal);
  const value = await (await moduleUnderTest()).runBenchmarkThread(req);
  assert.equal(value.state, 'failed');
  assert.equal(value.terminalReason, 'protocol_violation');
  assert.match(validateTrajectoryLifecycle({
    trajectoryRoot: req.trajectoryRoot, rootRunId: req.rootRunId, threadId: value.threadId,
  }).problems.join('\n'), /journal_path/);
});

it('refuses step N+1 through the orchestrator terminal path', async () => {
  queueSuccess('first', 0.1);
  harness.runAgent.mockImplementationOnce((_prompt: string, options: RunAgentOptions) => {
    spawnThrough(options);
    throw new Error('unreachable after admission refusal');
  });
  const req = request(path.join(root, 'step-limit'), new AbortController().signal, {
    template: 'fixture-two-step', limits: {
      maxSteps: 1, maxCostUsd: 1, deadlineEpochMs: Date.now() + 30_000,
    },
  });
  const value = await (await moduleUnderTest()).runBenchmarkThread(req);
  assert.equal(value.state, 'failed');
  assert.equal(value.terminalReason, 'step_limit_exceeded');
  assert.equal(value.steps, 1);
  assert.equal(harness.attachOptions.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(value.manifestPath, 'utf8')).terminal_reason, 'step_limit_exceeded');
});

it('fails when a completed step crosses the frozen cost limit', async () => {
  queueSuccess('over budget', 0.25);
  const req = request(path.join(root, 'cost-limit'), new AbortController().signal, {
    limits: { maxSteps: 2, maxCostUsd: 0.1, deadlineEpochMs: Date.now() + 30_000 },
  });
  const value = await (await moduleUnderTest()).runBenchmarkThread(req);
  assert.equal(value.state, 'failed');
  assert.equal(value.terminalReason, 'cost_limit_exceeded');
  assert.equal(value.costUsd, 0.25);
  assert.equal(JSON.parse(fs.readFileSync(value.manifestPath, 'utf8')).terminal_reason, 'cost_limit_exceeded');
});

for (const [name, cost] of [['zero', 0], ['equality', 0.25]] as const) {
  it(`allows ${name} cost at the frozen cost boundary`, async () => {
    queueSuccess(`${name} cost`, cost);
    const req = request(path.join(root, `${name}-cost`), new AbortController().signal, {
      limits: { maxSteps: 2, maxCostUsd: cost, deadlineEpochMs: Date.now() + 30_000 },
    });
    const value = await (await moduleUnderTest()).runBenchmarkThread(req);
    assert.equal(value.state, 'completed');
    assert.equal(value.terminalReason, null);
    assert.equal(value.costUsd, cost);
  });
}

it('admits a next step when cumulative cost exactly equals the limit', async () => {
  queueSuccess('first', 0.25);
  queueSuccess('second', 0);
  const req = request(path.join(root, 'equal-cost-next-step'), new AbortController().signal, {
    template: 'fixture-two-step',
    limits: { maxSteps: 2, maxCostUsd: 0.25, deadlineEpochMs: Date.now() + 30_000 },
  });
  const value = await (await moduleUnderTest()).runBenchmarkThread(req);
  assert.equal(value.state, 'completed');
  assert.equal(value.costUsd, 0.25);
  assert.equal(harness.runAgent.mock.calls.length, 2);
});

it('converts the absolute deadline once and returns deadline_exceeded', async () => {
  const quiescence = deferred<void>();
  quiescence.resolve();
  const supervisor = queueCancelableAgent(quiescence);
  const req = request(path.join(root, 'deadline'), new AbortController().signal, {
    limits: { maxSteps: 2, maxCostUsd: 1, deadlineEpochMs: Date.now() + 500 },
  });
  const value = await (await moduleUnderTest()).runBenchmarkThread(req);
  assert.equal(value.state, 'timeout');
  assert.equal(value.terminalReason, 'deadline_exceeded');
  assert.deepEqual(supervisor.cancel.mock.calls[0], ['deadline']);
  assert.equal(JSON.parse(fs.readFileSync(value.manifestPath, 'utf8')).terminal_reason, 'deadline_exceeded');
});

it('treats a pre-spawn agent short-circuit as quiescent without a supervisor', async () => {
  harness.runAgent.mockImplementationOnce(() => ({
    promise: Promise.resolve(result('pre-spawn')),
    kill: () => false,
    sessionId: null,
  }));
  const req = request(path.join(root, 'pre-spawn'), new AbortController().signal);
  const value = await (await moduleUnderTest()).runBenchmarkThread(req);
  assert.equal(value.state, 'completed');
  assert.equal(value.terminalReason, null);
  assert.equal(harness.lifecycle.includes('supervisor_closed'), false);
  assert.equal(validateTrajectoryLifecycle({
    trajectoryRoot: req.trajectoryRoot, rootRunId: req.rootRunId, threadId: value.threadId,
  }).ok, true);
});

it('does not start a network listener or any forbidden daemon subsystem', async () => {
  const listen = vi.spyOn(net.Server.prototype, 'listen');
  queueSuccess('isolated');
  const api = await moduleUnderTest();
  const req = request(path.join(root, 'isolation'), new AbortController().signal);

  await api.runBenchmarkThread(req);

  assert.equal(listen.mock.calls.length, 0);
  assert.ok(forbiddenSpies.every(spy => spy.mock.calls.length === 0));
  listen.mockRestore();
});
