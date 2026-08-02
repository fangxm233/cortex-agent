// input:  thread runner, fake agents, hook/throttle/profile stores
// output: benchmark isolation, exact accounting and regressions
// pos:    Verifies the benchmark-only thread execution boundary
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js';
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const agent = vi.hoisted(() => ({ runAgent: vi.fn() }));

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    runAgent: agent.runAgent,
    getActiveBackend: () => 'pi',
    getActiveProfile: () => 'active-pi',
    getClaudeMode: () => 'api',
  };
});

import { resolveMcpComposition, type AgentProcessSpawner } from '../src/agent-adapter/types.js';
import { CONFIG_DIR } from '../src/core/paths.js';
import { initHookBus } from '../src/core/hook-bus.js';
import { runningExecutions } from '../src/core/running-executions.js';
import type { AgentResult } from '../src/core/types/agent-types.js';
import type { RunThreadOptions, ThreadHookConfig, ThreadRecord } from '../src/core/types/thread-types.js';
import { buildAgentSpawnConfig, type RunAgentOptions } from '../src/domain/agents/facade.js';
import { resolveProfileConfig } from '../src/domain/agents/profile-manager.js';
import * as resumeRegistry from '../src/domain/costs/resume-registry.js';
import * as throttle from '../src/domain/costs/rate-limit-throttle.js';
import * as executionRegistry from '../src/domain/executions/registry.js';
import { ctx as jobCtx } from '../src/domain/scheduling/job-registry.js';
import {
  cleanupWorkspace,
  createThread,
  getTemplate,
  loadConfig,
} from '../src/domain/threads/index.js';
import { THREAD_PROTOCOL_PREAMBLE } from '../src/domain/threads/prompt-builder.js';
import * as threadRunner from '../src/domain/threads/runner.js';
import { profileRepo, PROFILES_FILE } from '../src/store/profile-repo.js';
import { sessionStore } from '../src/store/session-registry-repo.js';
import { threadStore } from '../src/store/thread-repo.js';
import type { HookEntry } from '../src/store/hook-registry.js';
import { MockAdapter } from '../src/platform/testing.js';

const createdThreadIds = new Set<string>();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-benchmark-run-'));

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeProfiles(): void {
  writeJson(PROFILES_FILE, {
    defaultProfile: 'active-pi',
    profiles: {
      'active-pi': { model: 'pi-fixture', backend: 'pi', provider: 'provider-a' },
      'pinned-claude': { model: 'claude-fixture', backend: 'claude', provider: 'provider-b' },
    },
  });
  profileRepo.invalidate();
}

function writeAgent(name: string, profile: string): void {
  writeJson(path.join(CONFIG_DIR, 'thread-templates', 'agents', `${name}.json`), {
    name,
    profile,
    persistSession: false,
    directive: `Directive for ${name}`,
    promptTemplate: 'Complete {{input}}',
  });
}

function writeTemplate(name: string, agents: string[], transitions: unknown[]): void {
  writeJson(path.join(CONFIG_DIR, 'thread-templates', 'templates', `${name}.json`), {
    name,
    description: `${name} fixture`,
    agents,
    transitions,
    entryAgent: agents[0],
    maxTotalSteps: 3,
  });
}

function writeThreadFixtures(): void {
  writeAgent('bench-alpha', '__active__');
  writeAgent('bench-beta', '__active__');
  writeAgent('bench-pinned', 'pinned-claude');
  writeTemplate('bench-two-step', ['bench-alpha', 'bench-beta'], [
    { from: 'bench-alpha', to: 'bench-beta', condition: { type: 'always' } },
  ]);
  writeTemplate('bench-active', ['bench-alpha'], []);
  writeTemplate('bench-hardcoded', ['bench-pinned'], []);
}

beforeAll(() => {
  writeProfiles();
  writeThreadFixtures();
  loadConfig();
});

beforeEach(() => {
  agent.runAgent.mockReset();
  initHookBus({ entries: [], hooksDir: tmpRoot });
  throttle._testReset();
  resumeRegistry._testReset();
  jobCtx.bus = null;
  const template = getTemplate('bench-two-step');
  if (template) delete template.hooks;
});

async function deleteCreatedThreads(): Promise<void> {
  for (const id of createdThreadIds) {
    const thread = threadStore.get(id);
    if (thread?.workspacePath) {
      try { cleanupWorkspace(id); } catch {}
    }
    await threadStore.delete(id);
  }
  createdThreadIds.clear();
  await threadStore.flush();
}

afterEach(async () => {
  jobCtx.bus = null;
  throttle._testReset();
  resumeRegistry._testReset();
  initHookBus({ entries: [], hooksDir: tmpRoot });
  await deleteCreatedThreads();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function createFixtureThread(templateName = 'bench-two-step'): ThreadRecord {
  const thread = createThread(`C-benchmark-${createdThreadIds.size}`, {
    templateName,
    userMessage: 'the same benchmark task',
    userMessageTs: String(Date.now()),
    projectId: 'atlas',
  });
  createdThreadIds.add(thread.id);
  return thread;
}

function benchmarkOptions(workspaceCwd: string, spawner?: AgentProcessSpawner) {
  return {
    workspaceCwd,
    resolvedProfileName: 'pinned-claude',
    expectedBackend: 'claude' as const,
    expectedModel: 'claude-fixture',
    disableHooks: true,
    disableControlPlane: true,
    failFastOnRateLimit: true,
    ...(spawner ? { spawner } : {}),
  } as const;
}

function runOptions(
  thread: ThreadRecord,
  benchmark?: ReturnType<typeof benchmarkOptions>,
  adapter = new MockAdapter(),
): RunThreadOptions {
  return {
    adapter,
    channel: thread.channel,
    destination: { type: 'interactive-reply', conduit: thread.channel, sessionId: '' },
    threadAnchorId: null,
    statusMsg: null,
    startTime: Date.now(),
    onProgress: null,
    ...(benchmark ? { benchmark } : {}),
  } as RunThreadOptions;
}

function result(sessionId: string, output = 'done'): AgentResult {
  return {
    sessionId,
    finalOutput: output,
    total_cost_usd: 0,
    num_turns: 1,
    rateLimited: false,
    rateLimitMessage: null,
    planFilePath: null,
    enteredPlanMode: false,
    exitedPlanMode: false,
  };
}

function handle(value: AgentResult, beforeResolve?: () => void | Promise<void>) {
  return {
    promise: Promise.resolve().then(beforeResolve).then(() => value),
    kill: () => true,
    sessionId: value.sessionId,
    agentProcess: undefined,
  };
}

function queueSuccesses(count: number, outputPrefix = 'step'): void {
  for (let index = 0; index < count; index++) {
    agent.runAgent.mockImplementationOnce(() => handle(
      result(`backend-${outputPrefix}-${index}`, `${outputPrefix}-${index}`),
    ));
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited code=${code} signal=${signal}`));
    });
  });
}

function assertCwdProbe(
  callCount: number,
  spawns: Array<{ command: string; cwd?: string | URL }>,
  marker: string,
  workspace: string,
): void {
  assert.equal(callCount, 2);
  assert.deepEqual(spawns, [
    { command: process.execPath, cwd: workspace },
    { command: process.execPath, cwd: workspace },
  ]);
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), [workspace, workspace]);
}

test('benchmark forwards workspace cwd and spawner through every step to a real child', async () => {
  const workspace = path.join(tmpRoot, 'workspace-cwd');
  const marker = path.join(tmpRoot, 'workspace-cwd.txt');
  fs.mkdirSync(workspace, { recursive: true });
  const spawns: Array<{ command: string; cwd?: string | URL }> = [];
  const spawner: AgentProcessSpawner = (command, args, options) => {
    spawns.push({ command, cwd: options.cwd });
    return { process: spawn(command, args, options) };
  };
  let call = 0;
  agent.runAgent.mockImplementation((_prompt: string, options: RunAgentOptions) => {
    assert.equal(options.cwd, workspace);
    assert.equal(options.processSpawner, spawner);
    const config = buildAgentSpawnConfig(options, resolveProfileConfig(options.profileName), undefined);
    assert.equal(config.cwd, workspace);
    assert.equal(config.processSpawner, spawner);
    assert.equal(config.preserveUnreportedAccounting, true);
    const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.cwd() + '\\n')`;
    const spawned = config.processSpawner!(process.execPath, ['-e', script], { cwd: config.cwd });
    const index = call++;
    return handle(result(`backend-cwd-${index}`, `cwd-${index}`), () => waitForExit(spawned.process));
  });
  const thread = createFixtureThread();

  await threadRunner.runThread(thread.id, runOptions(thread, benchmarkOptions(workspace, spawner)));

  assertCwdProbe(call, spawns, marker, workspace);
});

test('benchmark forwards every normalized event through its required per-step sink', async () => {
  const seen: Array<{ step: number; agentSlotId: string; event: unknown }> = [];
  const benchmark = benchmarkOptions(path.join(tmpRoot, 'event-sink')) as any;
  benchmark.requiredEventSink = (input: (typeof seen)[number]) => { seen.push(input); };
  let call = 0;
  agent.runAgent.mockImplementation((_prompt: string, options: RunAgentOptions) => {
    const event = { type: 'assistant_text' as const, text: `event-${call}` };
    assert.equal(options.loadCortexRules, false);
    assert.equal(options.streamDeltas, false);
    assert.equal(options.captureTranscriptLogs, false);
    assert.equal(options.preserveUnreportedAccounting, true);
    assert.equal(options.recordCost, false);
    assert.equal(options.requiredSinks?.length, 1);
    options.requiredSinks![0].onEvent(event);
    return handle(result(`backend-event-${call}`, `event-${call++}`));
  });
  const thread = createFixtureThread();

  await threadRunner.runThread(thread.id, runOptions(thread, benchmark));

  assert.deepEqual(seen, [
    { step: 0, agentSlotId: 'bench-alpha', event: { type: 'assistant_text', text: 'event-0' } },
    { step: 1, agentSlotId: 'bench-beta', event: { type: 'assistant_text', text: 'event-1' } },
  ]);
});

function markerHook(tag: string, markers: Map<string, string>): ThreadHookConfig {
  const marker = path.join(tmpRoot, `${tag}.marker`);
  const script = path.join(tmpRoot, `${tag}.mjs`);
  markers.set(tag, marker);
  fs.writeFileSync(script, [
    'import { writeFileSync } from "node:fs";',
    'for await (const _chunk of process.stdin) {}',
    `writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(tag)});`,
    'process.stdout.write(JSON.stringify({ insertAgent: false }));',
    '',
  ].join('\n'));
  return { command: `${process.execPath} ${script}`, timeout: 2_000 };
}

function configureAllHookRegistries(markers: Map<string, string>): RunThreadOptions['extraHooks'] {
  const template = getTemplate('bench-two-step');
  assert.ok(template);
  const phases = ['Start', 'Transition', 'End'] as const;
  template.hooks = Object.fromEntries(phases.map((phase) => [
    `on${phase}`, markerHook(`template-${phase.toLowerCase()}`, markers),
  ]));
  const extra = Object.fromEntries(phases.map((phase) => [
    `on${phase}`, markerHook(`extra-${phase.toLowerCase()}`, markers),
  ]));
  const entries = phases.map((phase): HookEntry => {
    const hook = markerHook(`global-${phase.toLowerCase()}`, markers);
    const script = hook.command.split(' ').at(-1)!;
    return {
      id: `global-${phase.toLowerCase()}`,
      event: `cortex:thread.${phase.toLowerCase()}`,
      run: { script: path.basename(script), timeout: 2 },
      result: 'hook-result',
    };
  });
  initHookBus({ entries, hooksDir: tmpRoot });
  return extra;
}

function assertMarkerState(markers: Map<string, string>, exists: boolean): void {
  assert.equal(markers.size, 9);
  for (const [tag, marker] of markers) {
    assert.equal(fs.existsSync(marker), exists, `${tag} marker existence`);
  }
}

test('benchmark skips template, extra, and global hooks while ordinary threads run all phases', async () => {
  const markers = new Map<string, string>();
  const extraHooks = configureAllHookRegistries(markers);
  const benchmark = createFixtureThread();
  queueSuccesses(2, 'benchmark-hooks');
  const benchmarkOpts = runOptions(benchmark, benchmarkOptions(path.join(tmpRoot, 'hook-workspace')));
  benchmarkOpts.extraHooks = extraHooks;

  await threadRunner.runThread(benchmark.id, benchmarkOpts);
  assertMarkerState(markers, false);

  const ordinary = createFixtureThread();
  queueSuccesses(2, 'ordinary-hooks');
  const ordinaryOpts = runOptions(ordinary);
  ordinaryOpts.extraHooks = extraHooks;
  await threadRunner.runThread(ordinary.id, ordinaryOpts);
  assertMarkerState(markers, true);
});

function stripProtocol(prompt: string): string {
  return prompt.replace(`${THREAD_PROTOCOL_PREAMBLE}\n\n`, '');
}

async function assertGuardRejects(
  benchmark: any,
  expected: RegExp,
  bus: any = null,
): Promise<void> {
  const thread = createFixtureThread('bench-active');
  const adapter = new MockAdapter();
  const openOutputStream = vi.spyOn(adapter, 'openOutputStream');
  jobCtx.bus = bus;
  agent.runAgent.mockReset();
  await assert.rejects(
    () => threadRunner.runThread(thread.id, runOptions(thread, benchmark, adapter)),
    expected,
  );
  assert.equal(openOutputStream.mock.calls.length, 0);
  assert.equal(agent.runAgent.mock.calls.length, 0);
  jobCtx.bus = null;
}

async function assertBenchmarkGuards(): Promise<void> {
  await assertGuardRejects(benchmarkOptions('relative/workspace'), /workspaceCwd.*absolute/i);
  const workspace = path.join(tmpRoot, 'guard-workspace');
  for (const field of ['disableHooks', 'disableControlPlane', 'failFastOnRateLimit']) {
    for (const invalid of [false, 1, 'true']) {
      await assertGuardRejects({ ...benchmarkOptions(workspace), [field]: invalid }, /flags.*true/i);
    }
  }
  await assertGuardRejects(
    benchmarkOptions(workspace),
    /null event bus/i,
    { publish: vi.fn() },
  );
}

async function capturePrompts(benchmark: boolean): Promise<Array<[string, RunAgentOptions]>> {
  const calls: Array<[string, RunAgentOptions]> = [];
  agent.runAgent.mockImplementation((prompt: string, options: RunAgentOptions) => {
    calls.push([prompt, options]);
    const index = calls.length - 1;
    return handle(result(`backend-prompt-${benchmark}-${index}`, `same-output-${index}`));
  });
  const thread = createFixtureThread();
  const opts = benchmark
    ? runOptions(thread, benchmarkOptions(path.join(tmpRoot, 'prompt-workspace')))
    : runOptions(thread);
  await threadRunner.runThread(thread.id, opts);
  agent.runAgent.mockReset();
  return calls;
}

test('benchmark removes thread protocol and MCP controls while ordinary prompts keep both', async () => {
  await assertBenchmarkGuards();
  const benchmarkCalls = await capturePrompts(true);
  const ordinaryCalls = await capturePrompts(false);

  assert.equal(benchmarkCalls.length, 2);
  assert.equal(ordinaryCalls.length, 2);
  for (let index = 0; index < benchmarkCalls.length; index++) {
    const [benchmarkPrompt, benchmarkOpts] = benchmarkCalls[index];
    const [ordinaryPrompt, ordinaryOpts] = ordinaryCalls[index];
    assert.equal(benchmarkPrompt, stripProtocol(ordinaryPrompt));
    assert.equal(benchmarkPrompt.includes(THREAD_PROTOCOL_PREAMBLE), false);
    assert.equal(resolveMcpComposition(benchmarkOpts.mcpComposition, benchmarkOpts.useCoreMcp), 'none');
    assert.equal(benchmarkOpts.disableHooks, true);
    assert.equal(benchmarkOpts.useCoreMcp, undefined);
    assert.equal(ordinaryPrompt.includes(THREAD_PROTOCOL_PREAMBLE), true);
    assert.equal(resolveMcpComposition(ordinaryOpts.mcpComposition, ordinaryOpts.useCoreMcp), 'thread-control');
    assert.equal(ordinaryOpts.useCoreMcp, true);
  }
});

function resetRateLimitState(): void {
  throttle._testReset();
  resumeRegistry._testReset();
}

async function activateUsageThrottle(provider = 'provider-b'): Promise<void> {
  await throttle.initRateLimitThrottle(new MockAdapter({ adminChannel: 'admin' }), {
    save: async () => {},
    load: async () => null,
  });
  await throttle.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.99, resetsAt: Math.floor(Date.now() / 1000) + 3_000 },
    { provider, displayName: provider, mode: 'api' },
  );
}

function rateLimitedResult(provider?: string): AgentResult {
  return {
    ...result('backend-rate-limit'),
    rateLimited: true,
    rateLimitMessage: 'rate limit reached',
    ...(provider ? { rateLimitProvider: provider } : {}),
  };
}

function queueRateLimitFailure(failure: AgentResult | Error): { executionId: string | null } {
  const attempt = { executionId: null as string | null };
  agent.runAgent.mockImplementationOnce((_prompt: string, options: RunAgentOptions) => {
    attempt.executionId = options.executionId ?? null;
    if (failure instanceof Error) {
      return { promise: Promise.reject(failure), kill: () => true, sessionId: null };
    }
    return handle(failure);
  });
  return attempt;
}

function assertTerminalRateLimit(thread: ThreadRecord, caught: unknown, executionId: string | null): void {
  const ErrorCtor = (threadRunner as any).BenchmarkRateLimitError;
  assert.equal(typeof ErrorCtor, 'function');
  assert.ok(caught instanceof ErrorCtor);
  assert.equal((caught as any).name, 'BenchmarkRateLimitError');
  assert.equal((caught as any).code, 'BENCHMARK_RATE_LIMITED');
  assert.equal(threadStore.get(thread.id)?.status, 'failed');
  assert.notEqual(threadStore.get(thread.id)?.status, 'rate_limited');
  assert.ok(executionId);
  assert.equal(executionRegistry.getExecution(executionId)?.status, 'failed');
  assert.equal(runningExecutions.getById(executionId), null);
  assert.equal(resumeRegistry.getResumeCount(), 0);
  const windows = throttle.getThrottleState().providers.flatMap((state) => state.windows);
  assert.equal(windows.some((window) => window.type === 'outage'), false);
}

async function expectBenchmarkRateLimit(thread: ThreadRecord, failure: AgentResult | Error): Promise<any> {
  const attempt = queueRateLimitFailure(failure);
  let caught: unknown;
  try {
    await threadRunner.runThread(
      thread.id,
      runOptions(thread, benchmarkOptions(path.join(tmpRoot, `rate-${thread.id}`))),
    );
  } catch (error) {
    caught = error;
  }
  assertTerminalRateLimit(thread, caught, attempt.executionId);
  return caught;
}

async function expectSynchronousBenchmarkRateLimit(thread: ThreadRecord): Promise<any> {
  const attempt = { executionId: null as string | null };
  agent.runAgent.mockImplementationOnce((_prompt: string, options: RunAgentOptions) => {
    attempt.executionId = options.executionId ?? null;
    throw new Error('HTTP 429 synchronous rate limit');
  });
  let caught: unknown;
  try {
    await threadRunner.runThread(
      thread.id,
      runOptions(thread, benchmarkOptions(path.join(tmpRoot, `rate-sync-${thread.id}`))),
    );
  } catch (error) {
    caught = error;
  }
  assertTerminalRateLimit(thread, caught, attempt.executionId);
  return caught;
}

test('benchmark rate limits fail terminally while ordinary threads pause and enqueue resume', async () => {
  const unthrottled = createFixtureThread('bench-active');
  const unthrottledError = await expectBenchmarkRateLimit(unthrottled, rateLimitedResult('provider-b'));
  assert.equal(unthrottledError.provider, 'provider-b');

  resetRateLimitState();
  const thrown = createFixtureThread('bench-active');
  const thrownError = await expectBenchmarkRateLimit(thrown, new Error('HTTP 429 rate limit'));
  assert.equal(thrownError.provider, 'provider-b');

  resetRateLimitState();
  const synchronous = createFixtureThread('bench-active');
  const synchronousError = await expectSynchronousBenchmarkRateLimit(synchronous);
  assert.equal(synchronousError.provider, 'provider-b');

  resetRateLimitState();
  await activateUsageThrottle();
  const throttled = createFixtureThread('bench-active');
  const throttledError = await expectBenchmarkRateLimit(throttled, rateLimitedResult('provider-b'));
  assert.equal(throttledError.provider, 'provider-b');

  resumeRegistry._testReset();
  const ordinary = createFixtureThread('bench-active');
  agent.runAgent.mockImplementationOnce(() => handle(rateLimitedResult('provider-b')));
  const ordinaryResult = await threadRunner.runThread(ordinary.id, runOptions(ordinary));
  assert.equal(ordinaryResult.thread.status, 'rate_limited');
  assert.equal(resumeRegistry.getResumeCount(), 1);
  assert.equal(resumeRegistry.takeAllResumes()[0]?.provider, 'provider-b');
});

interface LedgerExpectation {
  profileName: string;
  backend: string;
}

async function runAndAssertLedgers(
  thread: ThreadRecord,
  opts: RunThreadOptions,
  expected: LedgerExpectation[],
): Promise<void> {
  const calls: RunAgentOptions[] = [];
  agent.runAgent.mockImplementation((_prompt: string, options: RunAgentOptions) => {
    const expectation = expected[calls.length];
    assert.ok(expectation);
    assert.equal(options.profileName, expectation.profileName);
    calls.push(options);
    return handle(result(`backend-ledger-${calls.length}`), () => {
      assert.equal(executionRegistry.getExecution(options.executionId!)?.backend, expectation.backend);
      assert.equal(runningExecutions.getById(options.executionId!)?.backend, expectation.backend);
    });
  });

  await threadRunner.runThread(thread.id, opts);

  assert.equal(calls.length, expected.length);
  for (let index = 0; index < calls.length; index++) {
    const options = calls[index];
    const expectation = expected[index];
    const session = await sessionStore.getById(options.trackSessionId!);
    assert.equal(executionRegistry.getExecution(options.executionId!)?.backend, expectation.backend);
    assert.equal(session?.profileName, expectation.profileName);
    assert.equal(session?.backend, expectation.backend);
  }
  agent.runAgent.mockReset();
}

test('step ledgers use the resolved profile and preserve ordinary active-backend equality', async () => {
  const benchmark = createFixtureThread();
  await runAndAssertLedgers(
    benchmark,
    runOptions(benchmark, benchmarkOptions(path.join(tmpRoot, 'identity-workspace'))),
    [
      { profileName: 'pinned-claude', backend: 'claude' },
      { profileName: 'pinned-claude', backend: 'claude' },
    ],
  );

  const ordinaryActive = createFixtureThread('bench-active');
  await runAndAssertLedgers(
    ordinaryActive,
    runOptions(ordinaryActive),
    [{ profileName: 'active-pi', backend: 'pi' }],
  );

  const ordinaryHardcoded = createFixtureThread('bench-hardcoded');
  await runAndAssertLedgers(
    ordinaryHardcoded,
    runOptions(ordinaryHardcoded),
    [{ profileName: 'pinned-claude', backend: 'claude' }],
  );
});
