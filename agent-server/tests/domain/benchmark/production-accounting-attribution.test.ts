// input:  production run attempt, scripted backends, spawn-linked identity, cost repo
// output: concurrent attempt accounting persistence and reload proofs
// pos:    Verifies durable request and token attribution
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// The old suite injected a fake `AgentAdapter` whose process yielded a raw `cost_record` and drove
// it through the deleted facade. The run layer now owns the pooled engine, so this suite drives a
// REAL attempt through `startAttempt` over a scripted backend (a fake Claude CLI child, and
// `pi-fake-runtime` for PI). The `cost_record` itself reaches the run exactly as before — through
// `EngineSession.ingestExternal`, which is the engine seam for an event the turn did not produce.
// The backends are scripted to settle without a cost record of their own, so each attempt produces
// exactly the one row under test.

import '../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { AgentProcessSpawner, Backend, EngineSpec } from '../../../src/agent-adapter/types.js';
import type { RunEvent } from '../../../src/agent-adapter/run-events.js';
import { ClaudeAdapter } from '../../../src/agent-adapter/claude/adapter.js';
import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../src/core/types/thread-types.js';
import {
  getProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  resetProductionAttemptIdentity,
} from '../../../src/domain/benchmark/production-attempt-identity.js';
import { startAttempt } from '../../../src/domain/runs/attempt.js';
import { engines, SessionEngines } from '../../../src/domain/runs/engines.js';
import type { ResolvedProfileConfig, RunAttemptConfig } from '../../../src/domain/agents/profile-manager.js';
import type { RunRequest } from '../../../src/domain/runs/request.js';
import {
  attemptFromFixture, runRequestFixture, type RunRequestFixtureInput,
} from '../../run-request-fixture.js';
import {
  makeFakeRuntimeFactory, type FakeRuntimeFactory,
} from '../../agent-adapter/pi-fake-runtime.js';
import { getCostSummary } from '../../../src/domain/costs/cost-tracker.js';
import { CostRepo, costRepo } from '../../../src/store/cost-repo.js';

/** The internally-created journal sinks, so the suite can perform the close the run layer omits. */
const journalCapture = vi.hoisted(() => ({
  sinks: [] as Array<{ onClose?: () => void | Promise<void> }>,
}));

vi.mock('../../../src/domain/benchmark/production-attempt-journal.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/domain/benchmark/production-attempt-journal.js')
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

const SHA = 'b'.repeat(64);
let root: string;
let costsPath: string;
let evidenceContext: ProductionBenchmarkEvidenceContext;
let pool: SessionEngines;
let piFake: FakeRuntimeFactory;
const originalCostsPath = process.env.CORTEX_COSTS_FILE;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-accounting-'));
  costsPath = path.join(root, 'data', 'costs.jsonl');
  process.env.CORTEX_COSTS_FILE = costsPath;
  costRepo._testReset();
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
});

afterEach(async () => {
  for (const sink of journalCapture.sinks.splice(0)) {
    try { void sink.onClose?.(); } catch { /* the journal is not this suite's subject */ }
  }
  vi.restoreAllMocks();
  await Promise.all(pool.listKeys().map((key) => pool.close(key)));
  await costRepo.flush();
  resetProductionAttemptIdentity();
  if (originalCostsPath === undefined) delete process.env.CORTEX_COSTS_FILE;
  else process.env.CORTEX_COSTS_FILE = originalCostsPath;
  costRepo._testReset();
  fs.rmSync(root, { recursive: true, force: true });
});

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

function initializeIdentity(backend: Backend): void {
  evidenceContext = {
    schema_version: 'cortex-production-benchmark-evidence-context/1',
    trial_id: 'trial-accounting', root_run_id: 'root-accounting',
    bundle_manifest_hash: SHA,
    model_execution: {
      model_alias_policy: { policy: 'exact' }, cli_name: backend,
      cli_version: `${backend}-fixture-1`, max_output_tokens: null,
    },
  };
  initializeProductionAttemptIdentity({
    storePath: path.join(root, 'data', 'benchmark-attempt-identities.jsonl'),
  });
}

/** A fake CLI child: each stdin write consumes the next script and replays it on stdout. */
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

/**
 * The Claude backend settles one turn and reports NO accounting of its own, so the only cost row
 * this attempt produces is the one the run layer ingests below. `preserveUnreportedAccounting`
 * makes the adapter honour that: without usage or `total_cost_usd` it emits no `cost_record`.
 */
function claudeSpawner(): AgentProcessSpawner {
  return (() => {
    const child = scriptedChild([[
      {
        type: 'result', subtype: 'success', is_error: false,
        num_turns: 1, session_id: 'backend-session', result: 'ok',
      },
    ]]);
    return { process: child };
  }) as AgentProcessSpawner;
}

/** The raw `cost_record` the old fake process yielded, now a RunEvent the engine ingests. */
function accountingEvent(
  backend: Backend,
  values: {
    input: number | null; output: number | null;
    cacheRead: number | null; cacheCreation: number | null;
    requests: number | null; cost?: number | null;
  },
): Extract<RunEvent, { type: 'cost_record' }> {
  const prompt = values.input === null || values.cacheRead === null || values.cacheCreation === null
    ? null : values.input + values.cacheRead + values.cacheCreation;
  return {
    type: 'cost_record', provider: backend === 'claude' ? 'anthropic' : 'deepseek',
    model: `${backend}-model`, tokens_in: prompt, tokens_out: values.output,
    prompt_tokens: prompt, cached_tokens: values.cacheRead,
    input_tokens: values.input, output_tokens: values.output,
    cache_read_tokens: values.cacheRead, cache_creation_tokens: values.cacheCreation,
    provider_requests: values.requests, cost_usd: values.cost === undefined ? 0.02 : values.cost,
  };
}

async function runAttempt(
  backend: Backend,
  suffix: string,
  event: Extract<RunEvent, { type: 'cost_record' }>,
): Promise<void> {
  const resolved = profile(backend);
  const override = attemptOverride(resolved);
  const isRoot = suffix === 'zero';
  const partial: RunRequestFixtureInput = {
    sessionKey: `session-${suffix}`,
    trackSessionId: `session-${suffix}`,
    profileName: resolved.name,
    model: resolved.model,
    piProvider: backend === 'pi' ? resolved.provider : undefined,
    claudeBackend: 'print',
    threadId: `thr-${suffix}`,
    taskId: `task-${suffix}`,
    taskProject: 'cortex-self',
    taskGeneration: `generation-${suffix}`,
    tools: 'Read',
    pluginDirs: [],
    mcpComposition: 'none',
    disableHooks: true,
    loadCortexRules: false,
    recordCost: true,
    project: 'cortex-self',
    trigger: 'thread',
    processSpawner: backend === 'claude' ? claudeSpawner() : undefined,
  };
  const base = runRequestFixture(partial, override);
  const request: RunRequest = {
    ...base,
    benchmark: {
      evidenceContext,
      identityDirective: '',
      rootThreadId: 'thr-zero',
      parentThreadId: isRoot ? null : 'thr-zero',
      templateName: 'benchmark-direct',
      agentSlotId: 'benchmark-direct',
      stage: null,
      preserveUnreportedAccounting: true,
    },
  };
  const piIndex = backend === 'pi' ? piFake.runtimes.length : -1;
  const handle = startAttempt({
    request,
    attempt: attemptFromFixture(partial, override),
    executionId: `exec-${suffix}`,
    route: backend === 'claude' ? PROXY_ROUTE : undefined,
    onEvent: () => {},
  });
  // Ingest before the backend settles, so the row is billed to the foreground turn (the run layer
  // stops recording once `foreground_result` lands).
  handle.engine.ingestExternal(event);
  if (backend === 'pi') {
    const runtime = await piFake.runtime(piIndex);
    await runtime.nextCall('prompt');
    runtime.emitAgentEnd({ provider: '', settle: true });
  }
  await handle.settled;
}

for (const backend of ['claude', 'pi'] as const) {
  test(`${backend} accounting keeps reported zero and unavailable distinct across concurrent attempts and reload`, async () => {
    initializeIdentity(backend);
    const suffixes = ['zero', 'unknown', 'known'];
    await Promise.all([
      runAttempt(backend, 'zero', accountingEvent(backend, {
        input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 1, cost: null,
      })),
      runAttempt(backend, 'unknown', accountingEvent(backend, {
        input: null, output: null, cacheRead: null, cacheCreation: null, requests: null,
      })),
      runAttempt(backend, 'known', accountingEvent(backend, {
        input: 10, output: 2, cacheRead: 7, cacheCreation: 3, requests: 2,
      })),
    ]);
    await costRepo.flush();

    const expectedAttempts = new Map(suffixes.map((suffix) => [
      suffix, getProductionAttemptIdentity(`exec-${suffix}`)?.attempt_id,
    ]));
    resetProductionAttemptIdentity();
    const reloaded = await new CostRepo({
      costsPath, budgetPath: path.join(root, 'config', 'budget.json'),
    }).readCosts();
    assert.equal(reloaded.entries.length, 3);

    const rows = new Map(reloaded.entries.map((entry) => [entry.execution_id, entry]));
    const zero = rows.get('exec-zero');
    const unknown = rows.get('exec-unknown');
    assert.ok(zero);
    assert.ok(unknown);
    assert.deepEqual({
      cost: zero.cost_usd, input: zero.input_tokens, output: zero.output_tokens,
      cacheRead: zero.cache_read_tokens, cacheCreation: zero.cache_creation_tokens,
      requests: zero.provider_requests,
    }, { cost: null, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 1 });
    assert.deepEqual({
      input: unknown.input_tokens, output: unknown.output_tokens,
      cacheRead: unknown.cache_read_tokens, cacheCreation: unknown.cache_creation_tokens,
      requests: unknown.provider_requests,
    }, { input: null, output: null, cacheRead: null, cacheCreation: null, requests: null });

    for (const suffix of suffixes) {
      const row = rows.get(`exec-${suffix}`);
      assert.ok(row);
      assert.equal(row.session_id, `session-${suffix}`);
      assert.equal(row.thread_id, `thr-${suffix}`);
      assert.equal(row.task_id, `task-${suffix}`);
      assert.equal(row.dispatch_generation, `generation-${suffix}`);
      assert.equal(row.attempt_id, expectedAttempts.get(suffix));
      assert.equal(row.root_run_id, 'root-accounting');
    }

    const summary = await getCostSummary('cortex-self');
    assert.equal(summary.entryCount, 3);
    assert.equal(summary.tokens.total.input, 20);
    assert.equal(summary.tokens.total.output, 2);
  });
}
