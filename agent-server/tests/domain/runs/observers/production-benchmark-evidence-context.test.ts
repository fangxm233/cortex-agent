// input:  typed thread evidence context and a scripted Claude/PI backend
// output: context-gated identity, spawn linkage, and strict reads
// pos:    Verifies production benchmark evidence context behavior through a real run attempt
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// The suite used to inject a fake `AgentAdapter` and `preparedSpec` into the deleted facade. Its
// subject is the run layer's evidence bookkeeping, so it now drives a REAL attempt through
// `startAttempt`: a test-owned `SessionEngines` over a scripted Claude child and `pi-fake-runtime`.
// The spec `startAttempt` builds is the one it attests; there is no prepared spec any more.
//
// `startAttempt` does not close the journal sink it creates internally (the deleted facade did).
// That src gap is out of scope here, so the suite captures the sink and performs that close itself,
// exactly where the run layer used to — otherwise a second attempt on one execution id could never
// hit the journal's reuse guard.

import '../../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { AgentProcessSpawner, EngineSpec, Backend } from '../../../../src/agent-adapter/types.js';
import { ClaudeAdapter } from '../../../../src/agent-adapter/claude/adapter.js';
import { PIAdapter } from '../../../../src/agent-adapter/pi/adapter.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../../src/core/types/thread-types.js';
import {
  getProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  listProductionAttemptIdentities,
  readProductionAttemptIdentity,
  resetProductionAttemptIdentity,
} from '../../../../src/domain/runs/observers/production-attempt-identity.js';
import { computeRoleToolSurfaceHash } from '../../../../src/domain/runs/observers/identity.js';
import { roleSurfaceFromSpec } from '../../../../src/domain/runs/observers/role-surface.js';
import { startAttempt, type RunAttempt } from '../../../../src/domain/runs/attempt.js';
import { engines, SessionEngines } from '../../../../src/domain/runs/engines.js';
import type { ResolvedProfileConfig, RunAttemptConfig } from '../../../../src/domain/agents/profile-manager.js';
import type { RunRequest } from '../../../../src/domain/runs/request.js';
import {
  attemptFromFixture, runRequestFixture, type RunRequestFixtureInput,
} from '../../../run-request-fixture.js';
import {
  makeFakeRuntimeFactory, type FakeRuntimeFactory,
} from '../../../agent-adapter/pi-fake-runtime.js';

/** The internally-created journal sinks, so the suite can perform the close the run layer omits. */
const journalCapture = vi.hoisted(() => ({
  sinks: [] as Array<{ onClose?: () => void | Promise<void> }>,
}));

vi.mock('../../../../src/domain/runs/observers/production-attempt-journal.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../src/domain/runs/observers/production-attempt-journal.js')
  >();
  return {
    ...actual,
    createProductionAttemptJournalSink: (
      input: Parameters<typeof actual.createProductionAttemptJournalSink>[0],
    ) => {
      const sink = actual.createProductionAttemptJournalSink(input);
      journalCapture.sinks.push(sink);
      return sink;
    },
  };
});

/** The Anthropic route one attempt resolved; only the host is ever attested. */
const PROXY_ROUTE = { ANTHROPIC_BASE_URL: 'http://proxy.invalid' };

const SHA = 'c'.repeat(64);
let root: string;
let storePath: string;
let revision: { profiles: number; threads: number };
let pool: SessionEngines;
let piFake: FakeRuntimeFactory;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-evidence-context-'));
  storePath = path.join(root, 'data', 'attempt-identities.jsonl');
  revision = { profiles: 1, threads: 1 };
  journalCapture.sinks.length = 0;
  piFake = makeFakeRuntimeFactory();
  const piAdapter = new PIAdapter(
    piFake.factory,
    path.join(root, 'pi-sessions'),
    undefined,
    { agentDir: path.join(root, 'pi-agent') },
  );
  pool = new SessionEngines({ claude: new ClaudeAdapter(), pi: piAdapter });
  vi.spyOn(engines, 'acquire').mockImplementation((spec) => pool.acquire(spec));
  resetProductionAttemptIdentity();
  initializeProductionAttemptIdentity({
    storePath,
    configurationRevision: () => ({ ...revision }),
  });
});

afterEach(async () => {
  closeCapturedJournals();
  vi.restoreAllMocks();
  await Promise.all(pool.listKeys().map((key) => pool.close(key)));
  resetProductionAttemptIdentity();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Append every journal opened so far, the close `startAttempt` omits. */
function closeCapturedJournals(): void {
  for (const sink of journalCapture.sinks.splice(0)) {
    try { void sink.onClose?.(); } catch { /* the journal is not this suite's subject */ }
  }
}

function evidence(
  backend: Backend,
  scope: string = backend,
): ProductionBenchmarkEvidenceContext {
  return {
    schema_version: 'cortex-production-benchmark-evidence-context/1',
    trial_id: `trial-${scope}`,
    root_run_id: `root-${scope}`,
    bundle_manifest_hash: SHA,
    model_execution: {
      model_alias_policy: { policy: 'exact' },
      cli_name: backend,
      cli_version: `${backend}-fixture-1`,
      max_output_tokens: null,
    },
  };
}

function profile(backend: Backend): ResolvedProfileConfig {
  return {
    name: `benchmark-${backend}`,
    model: backend === 'claude' ? 'claude-fixture' : 'deepseek-fixture',
    backend,
    mode: 'trial',
    provider: backend === 'claude' ? 'anthropic' : 'deepseek',
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null, fallback: [],
  };
}

function attemptOverride(resolved: ResolvedProfileConfig): Partial<RunAttemptConfig> {
  return {
    model: resolved.model, backend: resolved.backend, mode: resolved.mode,
    provider: resolved.provider, extraEnv: resolved.extraEnv, extraOption: resolved.extraOption,
    claudeBackend: resolved.claudeBackend, thinking: resolved.thinking,
  };
}

/**
 * A fake CLI child: each write to stdin consumes the next script and replays it on stdout. The
 * evidence suites only need one settled turn, so every attempt gets a single success result.
 */
function scriptedChild(scripts: unknown[][]) {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = () => true;
  child.emitLines = (lines: unknown[]) => {
    for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
  };
  const queue = [...scripts];
  child.stdin.on('data', () => {
    const next = queue.shift();
    if (next) setImmediate(() => child.emitLines(next));
  });
  return child;
}

/** The Claude backend for an attempt: a scripted CLI process that resolves one turn. */
function claudeSpawner(): AgentProcessSpawner {
  return (() => {
    const child = scriptedChild([[
      {
        type: 'result', subtype: 'success', is_error: false,
        num_turns: 1, total_cost_usd: 0.02, session_id: 'backend-session', result: 'ok',
      },
    ]]);
    return { process: child };
  }) as AgentProcessSpawner;
}

interface AttemptOptions {
  executionId: string;
  threadId: string;
  rootThreadId?: string;
  parentThreadId?: string | null;
  template?: string;
  role?: string;
  stage?: string | null;
  tools?: string;
  taskId?: string | null;
  taskProject?: string | null;
  taskGeneration?: string | null;
  context?: ProductionBenchmarkEvidenceContext;
}

/**
 * Drive ONE attempt the way production's run layer does — `startAttempt` builds the spec, freezes
 * the identity and acquires the pooled engine. Synchronous on purpose so `assert.throws` still sees
 * a freeze refusal; the returned handle carries the two results the caller awaits.
 */
function runAttempt(
  backend: Backend,
  spawns: EngineSpec[],
  input: AttemptOptions,
): RunAttempt {
  const resolved = profile(backend);
  const override = attemptOverride(resolved);
  const partial: RunRequestFixtureInput = {
    sessionKey: input.executionId,
    trackSessionId: null,
    profileName: resolved.name,
    model: resolved.model,
    piProvider: backend === 'pi' ? resolved.provider : undefined,
    claudeBackend: 'print',
    threadId: input.threadId,
    taskId: input.taskId ?? null,
    taskProject: input.taskProject ?? null,
    taskGeneration: input.taskGeneration ?? null,
    tools: input.tools ?? 'Read',
    pluginDirs: [],
    mcpComposition: 'none',
    disableHooks: true,
    loadCortexRules: false,
    recordCost: false,
    processSpawner: backend === 'claude' ? claudeSpawner() : undefined,
  };
  const base = runRequestFixture(partial, override);
  const request: RunRequest = {
    ...base,
    benchmark: {
      evidenceContext: input.context ?? null,
      identityDirective: 'Resolved directive',
      rootThreadId: input.rootThreadId ?? input.threadId,
      parentThreadId: input.parentThreadId ?? null,
      templateName: input.template ?? 'benchmark-direct',
      agentSlotId: input.role ?? 'benchmark-direct',
      stage: input.stage ?? null,
      preserveUnreportedAccounting: false,
    },
  };
  const handle = startAttempt({
    request,
    attempt: attemptFromFixture(partial, override),
    executionId: input.executionId,
    route: backend === 'claude' ? PROXY_ROUTE : undefined,
    onEvent: () => {},
  });
  spawns.push(handle.spec);
  if (backend === 'pi') {
    // Settle the runtime the PI attempt just opened; an unreported turn adds no cost record.
    const index = piFake.runtimes.length - 1;
    void (async () => {
      const runtime = await piFake.runtime(index);
      await runtime.nextCall('prompt');
      runtime.emitAgentEnd({ provider: '', settle: true });
    })();
  }
  return handle;
}

for (const backend of ['claude', 'pi'] as const) {
  test(`${backend} direct, coder-review, and dispatched manager attempts use typed context`, async () => {
    const spawns: EngineSpec[] = [];
    for (const [kind, role, taskId] of [
      ['direct', 'benchmark-direct', null],
      ['coder', 'benchmark-coder', null],
      ['manager', 'benchmark-manager', 'a1b2'],
    ] as const) {
      const executionId = `${backend}-${kind}`;
      await runAttempt(backend, spawns, {
        executionId, threadId: `${executionId}-thread`, context: evidence(backend, executionId),
        template: kind === 'coder' ? 'benchmark-coder-review' : `benchmark-${kind}`,
        role, stage: kind === 'coder' ? 'implement' : null, taskId,
        taskProject: taskId ? 'atlas' : null, taskGeneration: taskId ? 'generation-1' : null,
      }).settled;
      assert.equal(getProductionAttemptIdentity(executionId)?.execution_id, executionId);
    }
    assert.equal(spawns.length, 3);
  });
}

test('coder, reviewer, and fixer form the exact same-thread spawn chain', async () => {
  const context = evidence('claude', 'coder-review-fix');
  const spawns: EngineSpec[] = [];
  for (const [suffix, role, tools] of [
    ['coder', 'benchmark-coder', 'Read,Write'],
    ['reviewer', 'benchmark-reviewer', 'Read'],
    ['fixer', 'benchmark-fixer', 'Read,Write'],
  ] as const) {
    await runAttempt('claude', spawns, {
      executionId: suffix, threadId: 'thread-three', context,
      template: 'benchmark-coder-review', role, tools,
    }).settled;
  }

  const records = ['coder', 'reviewer', 'fixer'].map(readProductionAttemptIdentity);
  assert.equal(records[0].spawn_parent_attempt_id, null);
  assert.equal(records[1].spawn_parent_attempt_id, records[0].attempt_id);
  assert.equal(records[2].spawn_parent_attempt_id, records[1].attempt_id);
  assert.ok(records.every(row => row.root_attempt_id === records[0].attempt_id));
  const listed = listProductionAttemptIdentities({
    trialId: context.trial_id, rootRunId: context.root_run_id,
  });
  assert.deepEqual(listed, records);
  assert.equal(Object.isFrozen(listed), true);
});

test('retry, resumed, and nested executions cannot collide with the root attempt', async () => {
  const context = evidence('claude');
  const spawns: EngineSpec[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'root-first', threadId: 'root-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-coder',
  }).settled;
  await runAttempt('claude', spawns, {
    executionId: 'root-retry', threadId: 'root-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-coder',
  }).settled;

  // The run layer omits the journal close; perform it, then reload so the reuse guard can see it.
  closeCapturedJournals();
  resetProductionAttemptIdentity();
  initializeProductionAttemptIdentity({ storePath });
  await runAttempt('claude', spawns, {
    executionId: 'root-resumed', threadId: 'root-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-reviewer',
  }).settled;
  await runAttempt('claude', spawns, {
    executionId: 'nested-manager', threadId: 'child-thread', rootThreadId: 'root-thread',
    parentThreadId: 'root-thread', context,
    template: 'benchmark-manager', role: 'benchmark-manager',
  }).settled;

  const records = ['root-first', 'root-retry', 'root-resumed', 'nested-manager']
    .map(readProductionAttemptIdentity);
  assert.equal(new Set(records.map(row => row.attempt_id)).size, records.length);
  assert.ok(records.every(row => row.root_attempt_id === records[0].attempt_id));
  assert.equal(records[0].spawn_parent_attempt_id, null);
  assert.equal(records[1].spawn_parent_attempt_id, records[0].attempt_id);
  assert.equal(records[2].spawn_parent_attempt_id, records[1].attempt_id);
  assert.equal(records[3].spawn_parent_attempt_id, records[2].attempt_id);

  const retryBeforeReuse = records[1];
  assert.throws(() => runAttempt('claude', spawns, {
    executionId: 'root-retry', threadId: 'root-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-coder',
  }), /journal already exists/i);
  assert.deepEqual(readProductionAttemptIdentity('root-retry'), retryBeforeReuse);
});

test('child and dispatcher-created task attempts use the latest causal parent attempt', async () => {
  const context = evidence('claude', 'children');
  const spawns: EngineSpec[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'manager-first', threadId: 'manager-thread', context,
    template: 'benchmark-manager', role: 'benchmark-manager',
  }).settled;
  const first = readProductionAttemptIdentity('manager-first');

  await Promise.all(['child-a', 'child-b'].map(async (executionId) => runAttempt('claude', spawns, {
    executionId, threadId: `${executionId}-thread`, rootThreadId: 'manager-thread',
    parentThreadId: 'manager-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-coder',
  }).settled));
  assert.equal(readProductionAttemptIdentity('child-a').spawn_parent_attempt_id, first.attempt_id);
  assert.equal(readProductionAttemptIdentity('child-b').spawn_parent_attempt_id, first.attempt_id);

  await runAttempt('claude', spawns, {
    executionId: 'child-a-review', threadId: 'child-a-thread', rootThreadId: 'manager-thread',
    parentThreadId: 'manager-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-reviewer',
  }).settled;
  assert.equal(
    readProductionAttemptIdentity('child-a-review').spawn_parent_attempt_id,
    readProductionAttemptIdentity('child-a').attempt_id,
  );

  await runAttempt('claude', spawns, {
    executionId: 'manager-resumed', threadId: 'manager-thread', context,
    template: 'benchmark-manager', role: 'benchmark-manager',
  }).settled;
  const resumed = readProductionAttemptIdentity('manager-resumed');
  await runAttempt('claude', spawns, {
    executionId: 'dispatch-child', threadId: 'dispatch-child-thread',
    rootThreadId: 'manager-thread', parentThreadId: 'manager-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-coder',
    taskId: 'b2c3', taskProject: 'atlas', taskGeneration: 'generation-child',
  }).settled;
  const dispatched = readProductionAttemptIdentity('dispatch-child');
  assert.equal(dispatched.spawn_parent_attempt_id, resumed.attempt_id);
  assert.equal(dispatched.task_id, 'b2c3');
  assert.equal(dispatched.dispatch_generation, 'generation-child');
});

test('absence disables observability while malformed context refuses before spawn', async () => {
  const spawns: EngineSpec[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'without-context', threadId: 'without-context',
  }).settled;
  assert.equal(getProductionAttemptIdentity('without-context'), null);
  assert.equal(fs.existsSync(storePath), false);

  const malformed = {
    ...evidence('claude'),
    model_execution: { cli_name: 'claude' },
  } as unknown as ProductionBenchmarkEvidenceContext;
  assert.throws(() => runAttempt('claude', spawns, {
    executionId: 'malformed-context', threadId: 'malformed-context', context: malformed,
  }), /evidence context.*invalid|model_execution/i);
  assert.equal(spawns.length, 1);
});

test('fails closed when a child first execution cannot resolve its parent attempt', async () => {
  const context = evidence('claude', 'missing-parent');
  const spawns: EngineSpec[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'root-existing', threadId: 'root-existing-thread', context,
  }).settled;
  assert.throws(() => runAttempt('claude', spawns, {
    executionId: 'child-orphan', threadId: 'child-orphan-thread',
    rootThreadId: 'root-existing-thread', parentThreadId: 'missing-parent-thread', context,
  }), /parent.*attempt|spawn parent/i);
  assert.equal(getProductionAttemptIdentity('child-orphan'), null);
  assert.equal(spawns.length, 1);
});

test('strict reads refuse unknown executions and run scopes', () => {
  assert.throws(() => readProductionAttemptIdentity('unknown-execution'),
    /attempt identity.*not found/i);
  assert.throws(() => listProductionAttemptIdentities({
    trialId: 'unknown-trial', rootRunId: 'unknown-root',
  }), /attempt identity.*not found|no production attempts/i);
});

test('reload rejects self-links, cross-run links, and attempt identity collisions', async () => {
  const spawns: EngineSpec[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'tamper-one', threadId: 'tamper-thread-one',
    context: evidence('claude', 'tamper-one'),
  }).settled;
  await runAttempt('claude', spawns, {
    executionId: 'tamper-two', threadId: 'tamper-thread-two',
    context: evidence('claude', 'tamper-two'),
  }).settled;
  const original = fs.readFileSync(storePath, 'utf8').trimEnd().split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
  const firstAttempt = String(original[0].attempt_id);
  const variants = [
    original.map((row, index) => index === 0
      ? { ...row, spawn_parent_attempt_id: firstAttempt } : row),
    original.map((row, index) => index === 1
      ? { ...row, spawn_parent_attempt_id: firstAttempt } : row),
    original.map((row, index) => index === 1
      ? { ...row, attempt_id: firstAttempt } : row),
  ];

  fs.writeFileSync(storePath, `${variants[0].map(row => JSON.stringify(row)).join('\n')}\n`);
  assert.throws(() => initializeProductionAttemptIdentity({ storePath }), /self|topology/i);
  assert.equal(getProductionAttemptIdentity('tamper-one'), null);

  for (const records of variants.slice(1)) {
    resetProductionAttemptIdentity();
    fs.writeFileSync(storePath, `${records.map(row => JSON.stringify(row)).join('\n')}\n`);
    assert.throws(() => initializeProductionAttemptIdentity({ storePath }),
      /cross|collision|topology|spawn parent|store invalid/i);
  }
});

test('root baseline refuses drift and the attested spec is the launched spec', async () => {
  const context = evidence('claude');
  const spawns: EngineSpec[] = [];
  const handle = runAttempt('claude', spawns, {
    executionId: 'baseline', threadId: 'baseline-thread', context,
  });
  await handle.settled;
  assert.ok(fs.existsSync(storePath));

  // `startAttempt` builds the spec once and both attests and launches that same object, so the
  // identity hash must equal the hash of the launched spec's role surface. This replaces the old
  // `preparedSpec` object-identity check, an option the run request contract no longer has.
  const identity = readProductionAttemptIdentity('baseline');
  assert.equal(
    identity.role_tool_surface_hash,
    computeRoleToolSurfaceHash(roleSurfaceFromSpec(handle.spec, 'Resolved directive')),
  );

  assert.throws(() => runAttempt('claude', spawns, {
    executionId: 'drifted', threadId: 'baseline-thread', context, tools: 'Write',
  }), /baseline|role.*drift|identity changed/i);
  assert.equal(spawns.length, 1);
});
