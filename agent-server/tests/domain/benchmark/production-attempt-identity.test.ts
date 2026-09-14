// input:  a resolved RunRequest driven through startAttempt over a real scripted backend
// output: identity freeze, linkage, drift, reload, secret containment
// pos:    Verifies production benchmark attempt identity freezing through the run layer
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// The suite used to hand-build `AgentProcess` objects and drive them through the deleted facade.
// Its subject is the run layer's identity freeze (the step inside `startAttempt`), so it now
// drives a REAL run: `startAttempt` acquires a real engine session from a test pool wired over a
// scripted backend. Claude is a scripted CLI child (via `request.isolation.spawner`); PI is a
// fake runtime (`pi-fake-runtime.ts`). No engine is faked: the assertions still read the spec the
// engine was actually opened from and the frozen record the spawn was allowed to happen after.

import '../../_test-home.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent-adapter/claude/adapter.js';
import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import type { AgentProcessSpawner, Backend } from '../../../src/agent-adapter/types.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../src/core/types/thread-types.js';
import {
  computeModelExecutionIdentityHash, computeRoleToolSurfaceHash,
} from '../../../src/domain/benchmark/identity.js';
import {
  getProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  resetProductionAttemptIdentity,
} from '../../../src/domain/benchmark/production-attempt-identity.js';
import { roleSurfaceFromSpec } from '../../../src/domain/benchmark/role-surface.js';
import { startAttempt, type RunAttempt } from '../../../src/domain/runs/attempt.js';
import { engines, SessionEngines } from '../../../src/domain/runs/engines.js';
import type {
  ResolvedProfileConfig, RunAttemptConfig,
} from '../../../src/domain/agents/profile-manager.js';
import type { RunRequest } from '../../../src/domain/runs/request.js';
import {
  makeFakeRuntimeFactory, type FakeRuntimeFactory,
} from '../../agent-adapter/pi-fake-runtime.js';
import { runRequestFixture } from '../../run-request-fixture.js';

/** The Anthropic route one attempt resolved; only the host of it is ever attested. */
const PROXY_ROUTE = { ANTHROPIC_BASE_URL: 'http://proxy.invalid' };
const TRIAL_ROUTE = { ANTHROPIC_BASE_URL: 'http://proxy.invalid/m/trial/anthropic' };

const SHA = 'a'.repeat(64);
let root: string;
let revision: { profiles: number; threads: number };
let pool: SessionEngines;
let piFake: FakeRuntimeFactory;
/** Set inside the backend's spawn seam: the identity store existed at the moment of spawn. */
let identityExistedAtSpawn = false;
let claudeSpawns = 0;
let piSpawns = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-attempt-identity-'));
  revision = { profiles: 1, threads: 1 };
  identityExistedAtSpawn = false;
  claudeSpawns = 0;
  piSpawns = 0;
  resetProductionAttemptIdentity();
  // A real pool over a real Claude adapter and a real PI adapter backed by the fake runtime. The
  // run layer reaches it through the daemon singleton, so the pool is installed there.
  piFake = makeFakeRuntimeFactory();
  const piAdapter = new PIAdapter(
    async (request, callbacks) => {
      identityExistedAtSpawn = fs.existsSync(storePath());
      piSpawns += 1;
      return piFake.factory(request, callbacks);
    },
    path.join(root, 'pi-sessions'),
    undefined,
    { agentDir: path.join(root, 'pi-agent') },
  );
  pool = new SessionEngines({ claude: new ClaudeAdapter(), pi: piAdapter });
  vi.spyOn(engines, 'acquire').mockImplementation((spec) => pool.acquire(spec));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pool.listKeys().map((key) => pool.close(key)));
  resetProductionAttemptIdentity();
  fs.rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  return path.join(root, 'data', 'benchmark-attempt-identities.jsonl');
}

function evidence(
  backend: Backend,
  maxOutputTokens: number | null = null,
): ProductionBenchmarkEvidenceContext {
  return {
    schema_version: 'cortex-production-benchmark-evidence-context/1',
    trial_id: 'trial-production-1',
    root_run_id: 'root-production-1',
    bundle_manifest_hash: SHA,
    model_execution: {
      model_alias_policy: { policy: 'exact' },
      cli_name: backend,
      cli_version: backend === 'claude' ? 'claude-fixture-1' : 'pi-fixture-1',
      max_output_tokens: maxOutputTokens,
    },
  };
}

function initialize(
  backend: Backend,
  maxOutputTokens: number | null = null,
): ProductionBenchmarkEvidenceContext {
  initializeProductionAttemptIdentity({
    storePath: storePath(), configurationRevision: () => ({ ...revision }),
  });
  return evidence(backend, maxOutputTokens);
}

function profile(backend: Backend): ResolvedProfileConfig {
  return {
    name: `benchmark-${backend}`,
    model: backend === 'claude' ? 'claude-fixture' : 'deepseek-fixture',
    backend,
    mode: 'trial',
    provider: backend === 'claude' ? 'anthropic' : 'deepseek',
    extraEnv: {}, extraOption: {}, claudeBackend: 'print',
    thinking: backend === 'claude' ? 'high' : 'off', fallback: [],
  };
}

/** The engine selection a resolved profile implies. The run layer keeps the two separate so the
 *  identity boundary can compare them; the fixture states both from one profile. */
function attemptOf(resolved: ResolvedProfileConfig): RunAttemptConfig {
  return {
    model: resolved.model, backend: resolved.backend, mode: resolved.mode,
    provider: resolved.provider, extraEnv: resolved.extraEnv, extraOption: resolved.extraOption,
    claudeBackend: resolved.claudeBackend, thinking: resolved.thinking,
  };
}

/** One successful Claude turn, as the CLI's stream-json would emit it. */
function claudeTurnScript(sessionId = 'backend-session'): unknown[] {
  return [
    { type: 'assistant', message: { model: 'claude-fixture', content: [{ type: 'text', text: 'ok' }] } },
    {
      type: 'result', subtype: 'success', is_error: false, num_turns: 1,
      total_cost_usd: 0, session_id: sessionId, result: 'ok',
    },
  ];
}

/** A stand-in for the CLI child the pool would normally spawn. The turn is replayed on stdout as
 *  soon as the session writes its prompt to stdin. */
function scriptedChild(script: unknown[]): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = () => true;
  child.stdin.on('data', () => {
    setImmediate(() => {
      for (const line of script) child.stdout.write(`${JSON.stringify(line)}\n`);
    });
  });
  return child;
}

function claudeSpawner(): AgentProcessSpawner {
  return (() => {
    identityExistedAtSpawn = fs.existsSync(storePath());
    claudeSpawns += 1;
    return { process: scriptedChild(claudeTurnScript()) };
  }) as AgentProcessSpawner;
}

interface PathCase {
  label: string;
  threadId: string;
  rootThreadId: string;
  parentThreadId: string | null;
  taskId: string | null;
  generation: string | null;
  template: string;
  role: string;
  stage: string | null;
}

const PATHS: PathCase[] = [
  {
    label: 'direct', threadId: 'thr-direct', rootThreadId: 'thr-direct',
    parentThreadId: null, taskId: null, generation: null,
    template: 'benchmark-direct', role: 'benchmark-direct', stage: null,
  },
  {
    label: 'coder-review', threadId: 'thr-coder-review', rootThreadId: 'thr-coder-review',
    parentThreadId: null, taskId: null, generation: null,
    template: 'benchmark-coder-review', role: 'benchmark-coder', stage: 'implement',
  },
  {
    label: 'task-dispatched manager', threadId: 'thr-manager', rootThreadId: 'thr-manager',
    parentThreadId: null, taskId: 'a1b2', generation: 'generation-1',
    template: 'benchmark-manager', role: 'benchmark-manager', stage: null,
  },
];

interface RequestOptions {
  evidenceContext: ProductionBenchmarkEvidenceContext | null;
  identityDirective?: string;
  tools?: string;
  processSpawner?: AgentProcessSpawner;
  sessionKey?: string;
}

/** Build the RunRequest the run layer consumes from a terse literal, the way every harness does. */
function makeRequest(
  backend: Backend,
  pathCase: PathCase,
  resolved: ResolvedProfileConfig,
  opts: RequestOptions,
): RunRequest {
  const request = runRequestFixture({
    sessionKey: opts.sessionKey ?? `identity-${backend}-${pathCase.label.replaceAll(' ', '-')}`,
    promptText: 'do work',
    threadId: pathCase.threadId,
    taskId: pathCase.taskId,
    taskProject: pathCase.taskId ? 'atlas' : null,
    taskGeneration: pathCase.generation,
    profileName: resolved.name,
    systemPrompt: 'Resolved system prompt',
    tools: opts.tools ?? 'Read,Write',
    pluginDirs: [],
    mcpComposition: 'none',
    disableHooks: true,
    loadCortexRules: false,
    recordCost: false,
    processSpawner: opts.processSpawner,
  }, attemptOf(resolved));
  // The run layer freezes identity from the resolved profile, not from the fixture's projection.
  request.profile = resolved;
  request.benchmark = {
    evidenceContext: opts.evidenceContext,
    identityDirective: opts.identityDirective ?? 'Act as the resolved role.',
    rootThreadId: pathCase.rootThreadId,
    parentThreadId: pathCase.parentThreadId,
    templateName: pathCase.template,
    agentSlotId: pathCase.role,
    stage: pathCase.stage,
    preserveUnreportedAccounting: false,
  };
  request.policy.background = 'none';
  return request;
}

function start(
  backend: Backend,
  request: RunRequest,
  resolved: ResolvedProfileConfig,
  executionId: string | null,
  route = backend === 'claude' ? PROXY_ROUTE : undefined,
): RunAttempt {
  const handle = startAttempt({
    request, attempt: attemptOf(resolved), executionId, route, onEvent: () => {},
  });
  void handle.foreground.catch(() => undefined);
  return handle;
}

/** Let the scripted backend answer the attempt's one turn, then wait for the attempt to settle. */
async function finish(handle: RunAttempt, backend: Backend, piIndex = 0): Promise<void> {
  if (backend === 'pi') {
    const runtime = await piFake.runtime(piIndex);
    await runtime.nextCall('prompt');
    runtime.emitSimpleTurn('ok');
  }
  // `foreground` awaits the attempt's result and its drained stream; `settled` is only reached on
  // the success terminal, which is all this suite drives.
  await handle.foreground;
}

function spawnCount(backend: Backend): number {
  return backend === 'claude' ? claudeSpawns : piSpawns;
}

for (const backend of ['claude', 'pi'] as const) {
  for (const pathCase of PATHS) {
    test(`freezes ${backend} ${pathCase.label} identity before the adapter spawn and reloads it`, async () => {
      const evidenceContext = initialize(backend);
      const executionId = `exec-${backend}-${pathCase.label.replaceAll(' ', '-')}`;
      const resolvedProfile = profile(backend);
      const request = makeRequest(backend, pathCase, resolvedProfile, {
        evidenceContext,
        processSpawner: backend === 'claude' ? claudeSpawner() : undefined,
      });
      const handle = start(
        backend, request, resolvedProfile, executionId,
        backend === 'claude' ? TRIAL_ROUTE : undefined,
      );

      await finish(handle, backend);
      assert.equal(spawnCount(backend), 1);
      assert.ok(identityExistedAtSpawn, 'identity must be durable before adapter spawn');

      const record = getProductionAttemptIdentity(executionId);
      assert.ok(record);
      assert.equal(record.trial_id, 'trial-production-1');
      assert.equal(record.root_run_id, 'root-production-1');
      assert.match(record.attempt_id, /^execution-/);
      assert.equal(record.root_attempt_id, record.attempt_id);
      assert.equal(record.execution_id, executionId);
      assert.equal(record.thread_id, pathCase.threadId);
      assert.equal(record.root_thread_id, pathCase.rootThreadId);
      assert.equal(record.task_id, pathCase.taskId ?? 'trial-production-1');
      assert.equal(record.dispatch_generation, pathCase.generation);
      assert.equal(record.template, pathCase.template);
      assert.equal(record.role, pathCase.role);
      assert.equal(record.stage, pathCase.stage);
      assert.equal(record.bundle_manifest_hash, SHA);
      const routeHost = backend === 'claude' ? 'proxy.invalid' : '127.0.0.1:9880';
      assert.equal(record.model_execution_identity_hash, computeModelExecutionIdentityHash({
        backend, requestedModel: resolvedProfile.model,
        modelAliasPolicy: { policy: 'exact' }, providerProtocol: resolvedProfile.provider,
        configuredRouteBaseHost: routeHost,
        claudeCliVersion: backend === 'claude' ? 'claude-fixture-1' : null,
        cliName: backend, cliVersion: backend === 'claude' ? 'claude-fixture-1' : 'pi-fixture-1',
        reasoningEffort: resolvedProfile.thinking, maxOutputTokens: null, fallbackEmpty: true,
      }));
      assert.equal(record.role_tool_surface_hash, computeRoleToolSurfaceHash(
        roleSurfaceFromSpec(handle.spec, 'Act as the resolved role.'),
      ));

      resetProductionAttemptIdentity();
      initializeProductionAttemptIdentity({
        storePath: storePath(), configurationRevision: () => ({ ...revision }),
      });
      assert.deepEqual(getProductionAttemptIdentity(executionId), record);
    });
  }
}

test('binds every execution to a unique attempt and the persisted first root execution', async () => {
  const evidenceContext = initialize('claude');
  const resolvedProfile = profile('claude');
  const run = async (executionId: string, threadId: string, rootThreadId: string) => {
    const pathCase: PathCase = {
      label: executionId, threadId, rootThreadId,
      parentThreadId: threadId === rootThreadId ? null : rootThreadId,
      taskId: null, generation: null,
      template: 'benchmark-coder-review', role: 'benchmark-coder', stage: 'implement',
    };
    const request = makeRequest('claude', pathCase, resolvedProfile, {
      evidenceContext, identityDirective: '', tools: 'Read',
      processSpawner: claudeSpawner(), sessionKey: `bind-${executionId}`,
    });
    await finish(start('claude', request, resolvedProfile, executionId, PROXY_ROUTE), 'claude');
  };

  await run('exec-root-first', 'thr-root', 'thr-root');
  resetProductionAttemptIdentity();
  initializeProductionAttemptIdentity({
    storePath: storePath(), configurationRevision: () => ({ ...revision }),
  });
  await run('exec-root-review', 'thr-root', 'thr-root');
  await run('exec-child', 'thr-child', 'thr-root');

  const first = getProductionAttemptIdentity('exec-root-first');
  const review = getProductionAttemptIdentity('exec-root-review');
  const child = getProductionAttemptIdentity('exec-child');
  assert.ok(first && review && child);
  assert.equal(new Set([first.attempt_id, review.attempt_id, child.attempt_id]).size, 3);
  assert.equal(first.root_attempt_id, first.attempt_id);
  assert.equal(review.root_attempt_id, first.attempt_id);
  assert.equal(child.root_attempt_id, first.attempt_id);
});

test('fails closed when a child attempt arrives before the production root attempt', () => {
  const evidenceContext = initialize('claude');
  const resolvedProfile = profile('claude');
  const pathCase: PathCase = {
    label: 'orphan-child', threadId: 'thr-child', rootThreadId: 'thr-root-missing',
    parentThreadId: 'thr-root-missing', taskId: null, generation: null,
    template: 'benchmark-manager', role: 'benchmark-manager', stage: null,
  };
  const request = makeRequest('claude', pathCase, resolvedProfile, {
    evidenceContext, identityDirective: '', tools: 'Read', processSpawner: claudeSpawner(),
  });
  assert.throws(
    () => start('claude', request, resolvedProfile, 'exec-orphan-child', PROXY_ROUTE),
    /root attempt|root execution/i,
  );
  assert.equal(claudeSpawns, 0);
});

test('keeps production identity observability absent without typed evidence context', async () => {
  initializeProductionAttemptIdentity({ storePath: storePath() });
  const resolvedProfile = profile('claude');
  const pathCase: PathCase = {
    label: 'without-context', threadId: 'thr-without-context',
    rootThreadId: 'thr-without-context', parentThreadId: null, taskId: null,
    generation: null, template: 'benchmark-direct', role: 'benchmark-direct', stage: null,
  };
  const request = makeRequest('claude', pathCase, resolvedProfile, {
    evidenceContext: null, identityDirective: '', tools: 'Read', processSpawner: claudeSpawner(),
  });
  await finish(start('claude', request, resolvedProfile, 'exec-without-context', PROXY_ROUTE), 'claude');
  assert.equal(getProductionAttemptIdentity('exec-without-context'), null);
  assert.equal(claudeSpawns, 1);
});

test('fails closed before spawn for fallback profiles, missing identity inputs, and hot reload drift', () => {
  const evidenceContext = initialize('claude');
  const resolvedProfile = profile('claude');
  const pathCase: PathCase = {
    label: 'refusal', threadId: 'thr-refusal', rootThreadId: 'thr-refusal',
    parentThreadId: null, taskId: null, generation: null,
    template: 'benchmark-direct', role: 'benchmark-direct', stage: null,
  };
  const fallbackProfile: ResolvedProfileConfig = {
    ...resolvedProfile,
    fallback: [{
      model: 'fallback', backend: 'claude', mode: null, provider: 'anthropic',
      extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
    }],
  };

  const fallbackRequest = makeRequest('claude', pathCase, fallbackProfile, {
    evidenceContext, identityDirective: '', tools: 'Read', processSpawner: claudeSpawner(),
  });
  assert.throws(
    () => start('claude', fallbackRequest, fallbackProfile, 'exec-refusal', PROXY_ROUTE),
    /fallback/i,
  );

  const missingIdRequest = makeRequest('claude', pathCase, resolvedProfile, {
    evidenceContext, identityDirective: '', tools: 'Read', processSpawner: claudeSpawner(),
  });
  assert.throws(
    () => start('claude', missingIdRequest, resolvedProfile, null, PROXY_ROUTE),
    /execution/i,
  );

  revision.threads += 1;
  const driftRequest = makeRequest('claude', pathCase, resolvedProfile, {
    evidenceContext, identityDirective: '', tools: 'Read', processSpawner: claudeSpawner(),
  });
  assert.throws(
    () => start('claude', driftRequest, resolvedProfile, 'exec-drift', PROXY_ROUTE),
    /hot.reload|drift/i,
  );
  assert.equal(claudeSpawns, 0);
});

test('hashes the effective Claude route after profile environment overrides', async () => {
  const evidenceContext = initialize('claude');
  const resolvedProfile: ResolvedProfileConfig = {
    ...profile('claude'),
    extraEnv: { ANTHROPIC_BASE_URL: 'http://profile-route.invalid/custom' },
  };
  const request = makeRequest('claude', PATHS[0], resolvedProfile, {
    evidenceContext, identityDirective: '', tools: 'Read',
    processSpawner: claudeSpawner(), sessionKey: 'route',
  });
  await finish(start('claude', request, resolvedProfile, 'exec-route', {
    ANTHROPIC_BASE_URL: 'http://gateway-route.invalid/m/trial/anthropic',
  }), 'claude');
  assert.equal(getProductionAttemptIdentity('exec-route')?.model_execution_identity_hash,
    computeModelExecutionIdentityHash({
      backend: 'claude', requestedModel: resolvedProfile.model,
      modelAliasPolicy: { policy: 'exact' }, providerProtocol: resolvedProfile.provider,
      configuredRouteBaseHost: 'profile-route.invalid', claudeCliVersion: 'claude-fixture-1',
      cliName: 'claude', cliVersion: 'claude-fixture-1',
      reasoningEffort: resolvedProfile.thinking, maxOutputTokens: null, fallbackEmpty: true,
    }));
});

for (const backend of ['claude', 'pi'] as const) {
  test(`refuses ${backend} spawn config that diverges from the resolved profile`, () => {
    const evidenceContext = initialize(backend);
    const resolvedProfile = profile(backend);
    const request = makeRequest(backend, PATHS[0], resolvedProfile, {
      evidenceContext, identityDirective: '', tools: 'Read',
      processSpawner: backend === 'claude' ? claudeSpawner() : undefined,
      sessionKey: `divergence-${backend}`,
    });
    // The old suite injected a prepared spec with a substituted model. The new seam has no
    // prepared spec: divergence is the attempt config naming a model the profile did not resolve.
    const divergent: RunAttemptConfig = { ...attemptOf(resolvedProfile), model: 'substituted-model' };
    assert.throws(() => startAttempt({
      request, attempt: divergent, executionId: `exec-${backend}-divergence`,
      route: backend === 'claude' ? PROXY_ROUTE : undefined, onEvent: () => {},
    }), /model.*drift|diverge/i);
    assert.equal(spawnCount(backend), 0);
  });
}

/** Every file the attempt evidence writes under the store root. */
function evidenceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? evidenceFiles(absolute) : [absolute];
  });
}

test('per-spawn route credentials reach the child env but never the attestation', async () => {
  const evidenceContext = initialize('claude');
  const resolvedProfile = profile('claude');
  const pathCase: PathCase = {
    ...PATHS[0], label: 'route-secret',
    threadId: 'thr-route-secret', rootThreadId: 'thr-route-secret',
  };
  const route = {
    ...TRIAL_ROUTE,
    ANTHROPIC_API_KEY: 'sk-must-not-be-attested',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-must-not-be-attested',
  };
  const request = makeRequest('claude', pathCase, resolvedProfile, {
    evidenceContext, identityDirective: '', tools: 'Read',
    processSpawner: claudeSpawner(), sessionKey: 'route-secret',
  });
  const handle = start('claude', request, resolvedProfile, 'exec-route-secret', route);
  await finish(handle, 'claude');

  assert.equal(handle.spec.env.sets?.ANTHROPIC_API_KEY, 'sk-must-not-be-attested');
  assert.equal(handle.spec.env.sets?.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-must-not-be-attested');
  const record = getProductionAttemptIdentity('exec-route-secret');
  assert.ok(record);
  const written = evidenceFiles(path.dirname(storePath()))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .concat(JSON.stringify(record))
    .join('\n');
  assert.ok(written.includes('exec-route-secret'), 'the evidence under test must be non-empty');
  for (const secret of ['sk-must-not-be-attested', 'oauth-must-not-be-attested']) {
    assert.ok(!written.includes(secret), `attestation leaked ${secret}`);
  }
  // Only the host of the route is attested — never the path, query, or any credential.
  assert.equal(record.model_execution_identity_hash, computeModelExecutionIdentityHash({
    backend: 'claude', requestedModel: resolvedProfile.model,
    modelAliasPolicy: { policy: 'exact' }, providerProtocol: resolvedProfile.provider,
    configuredRouteBaseHost: 'proxy.invalid', claudeCliVersion: 'claude-fixture-1',
    cliName: 'claude', cliVersion: 'claude-fixture-1',
    reasoningEffort: resolvedProfile.thinking, maxOutputTokens: null, fallbackEmpty: true,
  }));
});

test('does not expose mutable in-memory identity records', async () => {
  const evidenceContext = initialize('claude');
  const resolvedProfile = profile('claude');
  const pathCase: PathCase = {
    label: 'immutable', threadId: 'thr-immutable', rootThreadId: 'thr-immutable',
    parentThreadId: null, taskId: null, generation: null,
    template: 'benchmark-direct', role: 'benchmark-direct', stage: null,
  };
  const request = makeRequest('claude', pathCase, resolvedProfile, {
    evidenceContext, identityDirective: '', tools: 'Read',
    processSpawner: claudeSpawner(), sessionKey: 'immutable',
  });
  await finish(start('claude', request, resolvedProfile, 'exec-immutable', PROXY_ROUTE), 'claude');
  const record = getProductionAttemptIdentity('exec-immutable');
  assert.ok(record);
  assert.throws(() => { (record as { role: string }).role = 'mutated'; }, TypeError);
  assert.equal(getProductionAttemptIdentity('exec-immutable')?.role, 'benchmark-direct');
});

test('fails closed for unapplied output caps and incomplete task-dispatch identity', () => {
  const piEvidence = initialize('pi', 4096);
  const piProfile = profile('pi');
  const capCase: PathCase = {
    label: 'cap', threadId: 'thr-cap', rootThreadId: 'thr-cap', parentThreadId: null,
    taskId: null, generation: null, template: 'benchmark-direct',
    role: 'benchmark-direct', stage: null,
  };
  const capRequest = makeRequest('pi', capCase, piProfile, {
    evidenceContext: piEvidence, identityDirective: '', tools: 'Read',
  });
  assert.throws(
    () => start('pi', capRequest, piProfile, 'exec-cap', undefined),
    /output token.*drift/i,
  );

  resetProductionAttemptIdentity();
  const claudeEvidence = initialize('claude');
  const claudeProfile = profile('claude');
  const taskCase: PathCase = {
    ...capCase, label: 'task-incomplete',
    threadId: 'thr-task-incomplete', rootThreadId: 'thr-task-incomplete', taskId: 'a1b2',
  };
  const taskRequest = makeRequest('claude', taskCase, claudeProfile, {
    evidenceContext: claudeEvidence, identityDirective: '', tools: 'Read',
  });
  assert.throws(
    () => start('claude', taskRequest, claudeProfile, 'exec-task-incomplete', PROXY_ROUTE),
    /task project|dispatch generation/i,
  );
});

test('refuses reuse of an execution identity with a changed resolved spawn surface', async () => {
  const evidenceContext = initialize('claude');
  const resolvedProfile = profile('claude');
  const pathCase: PathCase = {
    label: 'reused', threadId: 'thr-reused', rootThreadId: 'thr-reused',
    parentThreadId: null, taskId: null, generation: null,
    template: 'benchmark-direct', role: 'benchmark-direct', stage: null,
  };
  const first = makeRequest('claude', pathCase, resolvedProfile, {
    evidenceContext, identityDirective: '', tools: 'Read',
    processSpawner: claudeSpawner(), sessionKey: 'reuse',
  });
  await finish(start('claude', first, resolvedProfile, 'exec-reused', PROXY_ROUTE), 'claude');

  const second = makeRequest('claude', pathCase, resolvedProfile, {
    evidenceContext, identityDirective: '', tools: 'Write',
    processSpawner: claudeSpawner(), sessionKey: 'reuse',
  });
  assert.throws(
    () => start('claude', second, resolvedProfile, 'exec-reused', PROXY_ROUTE),
    /identity changed|baseline.*drift/i,
  );
  assert.equal(claudeSpawns, 1);
});

test('rejects incomplete persisted identity records on reload', () => {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), `${JSON.stringify({
    schema_version: 'cortex-production-attempt-identity/3',
    execution_id: 'exec-incomplete', attempt_id: 'attempt-exec-incomplete',
  })}\n`);
  assert.throws(() => initializeProductionAttemptIdentity({
    storePath: storePath(), configurationRevision: () => ({ ...revision }),
  }), /store invalid/i);
});

test('rejects malformed typed evidence context before spawn', () => {
  initialize('pi');
  const malformed = {
    ...evidence('pi'),
    model_execution: { cli_name: 'pi' },
  } as unknown as ProductionBenchmarkEvidenceContext;
  const resolvedProfile = profile('pi');
  const pathCase: PathCase = {
    label: 'context-invalid', threadId: 'thr-context-invalid',
    rootThreadId: 'thr-context-invalid', parentThreadId: null, taskId: null,
    generation: null, template: 'benchmark-direct',
    role: 'benchmark-direct', stage: null,
  };
  const request = makeRequest('pi', pathCase, resolvedProfile, {
    evidenceContext: malformed, identityDirective: '', tools: 'Read',
  });
  assert.throws(
    () => start('pi', request, resolvedProfile, 'exec-context-invalid', undefined),
    /evidence context.*invalid|model_execution/i,
  );
  assert.equal(piSpawns, 0);
});
