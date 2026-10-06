//
// The suite used to inject a fake `AgentAdapter` and `preparedSpec` into the deleted facade. Its
// subject is the run layer's evidence bookkeeping, so it now drives a REAL attempt through
// `startAttempt`: a test-owned `SessionEngines` over a scripted Claude child and `pi-fake-runtime`.
// The spec `startAttempt` builds is the one it attests; there is no prepared spec any more.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { AgentProcessSpawner, EngineSpec, Backend } from '../../../src/agent-adapter/types.js';
import { ClaudeAdapter } from '../../../src/agent-adapter/claude/adapter.js';
import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../src/domain/benchmark/benchmark-types.js';
import {
  getProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  listProductionAttemptIdentities,
  resetProductionAttemptIdentity,
} from '../../../src/domain/benchmark/production-attempt-identity.js';
import { computeRoleToolSurfaceHash } from '../../../src/domain/benchmark/identity.js';
import { roleSurfaceFromSpec } from '../../../src/domain/benchmark/role-surface.js';
import { startAttempt, type RunAttempt } from '../../../src/domain/runs/attempt.js';
import { engines, SessionEngines } from '../../../src/domain/runs/engines.js';
import type { ResolvedProfileConfig } from '../../../src/domain/agents/profile-manager.js';
import type { RunRequest } from '../../../src/domain/runs/request.js';
import {
  attemptFromFixture, attemptOf, runRequestFixture, type RunRequestFixtureInput,
} from '../../run-request-fixture.js';
import {
  makeFakeRuntimeFactory, type FakeRuntimeFactory,
} from '../../agent-adapter/pi-fake-runtime.js';

/** The Anthropic route one attempt resolved; only the host is ever attested. */
const PROXY_ROUTE = { ANTHROPIC_BASE_URL: 'http://proxy.invalid' };

const SHA = 'c'.repeat(64);
let root: string;
let storePath: string;
let revision: { profiles: number; environments: number };
let pool: SessionEngines;
let piFake: FakeRuntimeFactory;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-evidence-context-'));
  storePath = path.join(root, 'data', 'attempt-identities.jsonl');
  revision = { profiles: 1, environments: 1 };
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
  vi.restoreAllMocks();
  await Promise.all(pool.listKeys().map((key) => pool.close(key)));
  resetProductionAttemptIdentity();
  fs.rmSync(root, { recursive: true, force: true });
});

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
    extraEnv: {}, extraOption: {}, thinking: null, fallback: [],
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
  sessionId: string;
  tools?: string;
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
  const override = attemptOf(resolved);
  const partial: RunRequestFixtureInput = {
    sessionKey: input.executionId,
    trackSessionId: input.sessionId,
    profileName: resolved.name,
    model: resolved.model,
    piProvider: backend === 'pi' ? resolved.provider : undefined,
   
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
  test(`${backend} session attempts use typed context`, async () => {
    const spawns: EngineSpec[] = [];
    const executionId = `${backend}-direct`;
    await runAttempt(backend, spawns, {
      executionId, sessionId: `${executionId}-session`, context: evidence(backend, executionId),
    }).settled;
    const identity = getProductionAttemptIdentity(executionId);
    assert.equal(identity?.execution_id, executionId);
    assert.equal(identity?.session_id, `${executionId}-session`);
    assert.equal(spawns.length, 1);
  });
}

test('a session\'s executions form the exact spawn chain', async () => {
  const context = evidence('claude', 'session-chain');
  const spawns: EngineSpec[] = [];
  for (const executionId of ['first', 'second', 'third']) {
    await runAttempt('claude', spawns, { executionId, sessionId: 'session-chain', context }).settled;
  }

  const records = ['first', 'second', 'third'].map(id => getProductionAttemptIdentity(id)!);
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

test('retried and resumed executions cannot collide with the root attempt', async () => {
  const context = evidence('claude');
  const spawns: EngineSpec[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'root-first', sessionId: 'root-session', context,
  }).settled;
  await runAttempt('claude', spawns, {
    executionId: 'root-retry', sessionId: 'root-session', context,
  }).settled;

  resetProductionAttemptIdentity();
  initializeProductionAttemptIdentity({ storePath });
  await runAttempt('claude', spawns, {
    executionId: 'root-resumed', sessionId: 'root-session', context,
  }).settled;

  const records = ['root-first', 'root-retry', 'root-resumed']
    .map(id => getProductionAttemptIdentity(id)!);
  assert.equal(new Set(records.map(row => row.attempt_id)).size, records.length);
  assert.ok(records.every(row => row.root_attempt_id === records[0].attempt_id));
  assert.equal(records[0].spawn_parent_attempt_id, null);
  assert.equal(records[1].spawn_parent_attempt_id, records[0].attempt_id);
  assert.equal(records[2].spawn_parent_attempt_id, records[1].attempt_id);

  const retryBeforeReuse = records[1];
  assert.throws(() => runAttempt('claude', spawns, {
    executionId: 'root-retry', sessionId: 'root-session', context,
  }), /journal already exists/i);
  assert.deepEqual(getProductionAttemptIdentity('root-retry')!, retryBeforeReuse);
});

test('absence disables observability while malformed context refuses before spawn', async () => {
  const spawns: EngineSpec[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'without-context', sessionId: 'without-context',
  }).settled;
  assert.equal(getProductionAttemptIdentity('without-context'), null);
  assert.equal(fs.existsSync(storePath), false);

  const malformed = {
    ...evidence('claude'),
    model_execution: { cli_name: 'claude' },
  } as unknown as ProductionBenchmarkEvidenceContext;
  assert.throws(() => runAttempt('claude', spawns, {
    executionId: 'malformed-context', sessionId: 'malformed-context', context: malformed,
  }), /evidence context.*invalid|model_execution/i);
  assert.equal(spawns.length, 1);
});

test('strict reads refuse unknown run scopes', () => {
  assert.throws(() => listProductionAttemptIdentities({
    trialId: 'unknown-trial', rootRunId: 'unknown-root',
  }), /attempt identity.*not found|no production attempts/i);
});

test('reload rejects self-links, cross-run links, and attempt identity collisions', async () => {
  const spawns: EngineSpec[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'tamper-one', sessionId: 'tamper-session-one',
    context: evidence('claude', 'tamper-one'),
  }).settled;
  await runAttempt('claude', spawns, {
    executionId: 'tamper-two', sessionId: 'tamper-session-two',
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
    executionId: 'baseline', sessionId: 'baseline-session', context,
  });
  await handle.settled;
  assert.ok(fs.existsSync(storePath));

  // `startAttempt` builds the spec once and both attests and launches that same object, so the
  // identity hash must equal the hash of the launched spec's role surface. This replaces the old
  // `preparedSpec` object-identity check, an option the run request contract no longer has.
  const identity = getProductionAttemptIdentity('baseline')!;
  assert.equal(
    identity.role_tool_surface_hash,
    computeRoleToolSurfaceHash(roleSurfaceFromSpec(handle.spec, 'Resolved directive')),
  );

  assert.throws(() => runAttempt('claude', spawns, {
    executionId: 'drifted', sessionId: 'baseline-session', context, tools: 'Write',
  }), /baseline|role.*drift|identity changed/i);
  assert.equal(spawns.length, 1);
});
