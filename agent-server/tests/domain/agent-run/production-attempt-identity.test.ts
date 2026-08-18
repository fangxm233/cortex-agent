// input:  production facade seam, injected benchmark identity, temp plugins
// output: pre-spawn identity, root linkage, drift, and reload proofs
// pos:    Verifies production benchmark attempt identity freezing
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import type {
  AgentAdapter, AgentProcess, AgentSpawnConfig, Backend,
} from '../../../src/agent-adapter/types.js';
import type { AgentResult } from '../../../src/core/types/agent-types.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../src/core/types/thread-types.js';
import {
  computeModelExecutionIdentityHash, computeRoleToolSurfaceHash,
} from '../../../src/domain/agent-run/identity.js';
import {
  getProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  resetProductionAttemptIdentity,
} from '../../../src/domain/agent-run/production-attempt-identity.js';
import { roleSurfaceFromSpawnConfig } from '../../../src/domain/agent-run/role-surface.js';
import type { ResolvedProfileConfig } from '../../../src/domain/agents/profile-manager.js';
import { _test as rawFacadeTest } from '../../../src/domain/agents/facade.js';

const SHA = 'a'.repeat(64);
let root: string;
let revision: { profiles: number; threads: number };
let activeEvidence: ProductionBenchmarkEvidenceContext | null;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-attempt-identity-'));
  revision = { profiles: 1, threads: 1 };
  activeEvidence = null;
  resetProductionAttemptIdentity();
});

afterEach(() => {
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

const facadeTest = {
  ...rawFacadeTest,
  runWithAdapter: (
    adapterValue: Parameters<typeof rawFacadeTest.runWithAdapter>[0],
    message: string,
    options: Parameters<typeof rawFacadeTest.runWithAdapter>[2],
    config: Parameters<typeof rawFacadeTest.runWithAdapter>[3],
    baseUrl: Parameters<typeof rawFacadeTest.runWithAdapter>[4],
  ) => rawFacadeTest.runWithAdapter(adapterValue, message, {
    ...options,
    productionBenchmarkEvidenceContext:
      options.productionBenchmarkEvidenceContext ?? activeEvidence,
  }, config, baseUrl),
};

function initialize(backend: Backend, maxOutputTokens: number | null = null): void {
  activeEvidence = evidence(backend, maxOutputTokens);
  initializeProductionAttemptIdentity({
    storePath: storePath(), configurationRevision: () => ({ ...revision }),
  });
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

function result(): AgentResult {
  return {
    sessionId: 'backend-session', finalOutput: 'ok', num_turns: 1,
    total_cost_usd: 0, rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
  };
}

function process(): AgentProcess {
  return {
    sessionKey: 'fixture', sessionId: 'backend-session',
    send: async () => result(),
    events: { async *[Symbol.asyncIterator]() {} },
    close: async () => {}, kill: () => true,
  };
}

function adapter(
  backend: Backend,
  spawns: AgentSpawnConfig[],
  requireIdentity = true,
): AgentAdapter {
  return {
    backend, capabilities: new Set(),
    spawn(config) {
      if (requireIdentity) {
        assert.ok(fs.existsSync(storePath()), 'identity must be durable before adapter.spawn');
      }
      spawns.push(config);
      return process();
    },
    close: async () => {}, kill: () => false, listSessions: () => [],
  };
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

for (const backend of ['claude', 'pi'] as const) {
  for (const pathCase of PATHS) {
    test(`freezes ${backend} ${pathCase.label} identity before the adapter spawn and reloads it`, async () => {
      initialize(backend);
      const spawns: AgentSpawnConfig[] = [];
      const executionId = `exec-${backend}-${pathCase.label.replaceAll(' ', '-')}`;
      const resolvedProfile = profile(backend);
      const config = {
        model: resolvedProfile.model, backend, mode: resolvedProfile.mode,
        provider: resolvedProfile.provider, extraEnv: resolvedProfile.extraEnv,
        extraOption: resolvedProfile.extraOption, claudeBackend: resolvedProfile.claudeBackend,
        thinking: resolvedProfile.thinking,
      };
      const handle = facadeTest.runWithAdapter(adapter(backend, spawns), 'do work', {
        executionId, threadId: pathCase.threadId, rootThreadId: pathCase.rootThreadId,
        parentThreadId: pathCase.parentThreadId, taskId: pathCase.taskId,
        taskProject: pathCase.taskId ? 'atlas' : null,
        taskGeneration: pathCase.generation, templateName: pathCase.template,
        agentSlotId: pathCase.role, stage: pathCase.stage,
        profileName: resolvedProfile.name, resolvedProfileConfig: resolvedProfile,
        identityDirective: 'Act as the resolved role.',
        systemPrompt: 'Resolved system prompt', tools: 'Read,Write',
        pluginDirs: [], mcpComposition: 'none', disableHooks: true,
        loadCortexRules: false,
      }, config, backend === 'claude' ? 'http://proxy.invalid/m/trial/anthropic' : undefined);

      await handle.promise;
      assert.equal(spawns.length, 1);
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
        roleSurfaceFromSpawnConfig(spawns[0], 'Act as the resolved role.'),
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
  initialize('claude');
  const resolvedProfile = profile('claude');
  const spawns: AgentSpawnConfig[] = [];
  const config = {
    model: resolvedProfile.model, backend: 'claude' as const, mode: resolvedProfile.mode,
    provider: resolvedProfile.provider, extraEnv: {}, extraOption: {}, claudeBackend: 'print' as const,
    thinking: resolvedProfile.thinking,
  };
  const run = async (executionId: string, threadId: string, rootThreadId: string) => {
    await facadeTest.runWithAdapter(adapter('claude', spawns), 'x', {
      executionId, threadId, rootThreadId, parentThreadId: threadId === rootThreadId ? null : rootThreadId,
      taskId: null, taskGeneration: null, templateName: 'benchmark-coder-review',
      agentSlotId: 'benchmark-coder', stage: 'implement', profileName: resolvedProfile.name,
      resolvedProfileConfig: resolvedProfile, identityDirective: '', tools: 'Read', pluginDirs: [],
      mcpComposition: 'none', disableHooks: true, loadCortexRules: false,
    }, config, 'http://proxy.invalid').promise;
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
  initialize('claude');
  const resolvedProfile = profile('claude');
  assert.throws(() => facadeTest.runWithAdapter(adapter('claude', []), 'x', {
    executionId: 'exec-orphan-child', threadId: 'thr-child', rootThreadId: 'thr-root-missing',
    parentThreadId: 'thr-root-missing', taskId: null, taskGeneration: null,
    templateName: 'benchmark-manager', agentSlotId: 'benchmark-manager', stage: null,
    profileName: resolvedProfile.name, resolvedProfileConfig: resolvedProfile,
    identityDirective: '', tools: 'Read', pluginDirs: [], mcpComposition: 'none',
    disableHooks: true, loadCortexRules: false,
  }, {
    model: resolvedProfile.model, backend: 'claude', mode: resolvedProfile.mode,
    provider: resolvedProfile.provider, extraEnv: {}, extraOption: {}, claudeBackend: 'print',
    thinking: resolvedProfile.thinking,
  }, 'http://proxy.invalid'), /root attempt|root execution/i);
});

test('keeps production identity observability absent without typed evidence context', async () => {
  initializeProductionAttemptIdentity({ storePath: storePath() });
  const resolvedProfile = profile('claude');
  const spawns: AgentSpawnConfig[] = [];
  await facadeTest.runWithAdapter(adapter('claude', spawns, false), 'x', {
    executionId: 'exec-without-context', threadId: 'thr-without-context',
    rootThreadId: 'thr-without-context', parentThreadId: null, taskId: null,
    taskGeneration: null, templateName: 'benchmark-direct', agentSlotId: 'benchmark-direct',
    stage: null, profileName: resolvedProfile.name, resolvedProfileConfig: resolvedProfile,
    identityDirective: '', tools: 'Read', pluginDirs: [], mcpComposition: 'none',
    disableHooks: true, loadCortexRules: false,
  }, {
    model: resolvedProfile.model, backend: 'claude', mode: resolvedProfile.mode,
    provider: resolvedProfile.provider, extraEnv: {}, extraOption: {}, claudeBackend: 'print',
    thinking: resolvedProfile.thinking,
  }, 'http://proxy.invalid').promise;
  assert.equal(getProductionAttemptIdentity('exec-without-context'), null);
  assert.equal(spawns.length, 1);
});

test('fails closed before spawn for fallback profiles, missing identity inputs, and hot reload drift', () => {
  initialize('claude');
  const spawns: AgentSpawnConfig[] = [];
  const resolvedProfile = profile('claude');
  const baseOptions = {
    executionId: 'exec-refusal', threadId: 'thr-refusal', rootThreadId: 'thr-refusal',
    parentThreadId: null, taskId: null, taskGeneration: null,
    templateName: 'benchmark-direct', agentSlotId: 'benchmark-direct', stage: null,
    profileName: resolvedProfile.name, resolvedProfileConfig: resolvedProfile,
    identityDirective: '', systemPrompt: '', tools: 'Read', pluginDirs: [],
    mcpComposition: 'none' as const, disableHooks: true, loadCortexRules: false,
  };
  const config = {
    model: resolvedProfile.model, backend: 'claude' as const, mode: resolvedProfile.mode,
    provider: resolvedProfile.provider, extraEnv: {}, extraOption: {}, claudeBackend: 'print' as const,
    thinking: resolvedProfile.thinking,
  };

  assert.throws(() => facadeTest.runWithAdapter(adapter('claude', spawns), 'x', {
    ...baseOptions,
    resolvedProfileConfig: { ...resolvedProfile, fallback: [{
      model: 'fallback', backend: 'claude', mode: null, provider: 'anthropic',
      extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
    }] },
  }, config, 'http://proxy.invalid'), /fallback/i);
  assert.equal(spawns.length, 0);

  assert.throws(() => facadeTest.runWithAdapter(adapter('claude', spawns), 'x', {
    ...baseOptions, executionId: null,
  }, config, 'http://proxy.invalid'), /execution/i);
  assert.equal(spawns.length, 0);

  revision.threads += 1;
  assert.throws(() => facadeTest.runWithAdapter(adapter('claude', spawns), 'x', {
    ...baseOptions, executionId: 'exec-drift',
  }, config, 'http://proxy.invalid'), /hot.reload|drift/i);
  assert.equal(spawns.length, 0);
});

test('hashes the effective Claude route after profile environment overrides', async () => {
  initialize('claude');
  const resolvedProfile = {
    ...profile('claude'),
    extraEnv: { ANTHROPIC_BASE_URL: 'http://profile-route.invalid/custom' },
  };
  await facadeTest.runWithAdapter(adapter('claude', []), 'x', {
    executionId: 'exec-route', threadId: 'thr-route', rootThreadId: 'thr-route',
    parentThreadId: null, taskId: null, taskGeneration: null,
    templateName: 'benchmark-direct', agentSlotId: 'benchmark-direct', stage: null,
    profileName: resolvedProfile.name, resolvedProfileConfig: resolvedProfile,
    identityDirective: '', tools: 'Read', pluginDirs: [], mcpComposition: 'none',
    disableHooks: true, loadCortexRules: false,
  }, {
    model: resolvedProfile.model, backend: 'claude', mode: resolvedProfile.mode,
    provider: resolvedProfile.provider, extraEnv: resolvedProfile.extraEnv,
    extraOption: {}, claudeBackend: 'print', thinking: resolvedProfile.thinking,
  }, 'http://gateway-route.invalid/m/trial/anthropic').promise;
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
    initialize(backend);
    const resolvedProfile = profile(backend);
    const spawns: AgentSpawnConfig[] = [];
    const config = {
      sessionId: null, sessionKey: 'fixture', resume: false,
      model: 'substituted-model', thinking: resolvedProfile.thinking ?? undefined,
      piProvider: backend === 'pi' ? resolvedProfile.provider ?? undefined : undefined,
      piGatewayBaseUrl: backend === 'pi' ? 'http://127.0.0.1:9880' : undefined,
      mcpComposition: 'none' as const, rawTools: 'Read', disableHooks: true,
    };
    assert.throws(() => facadeTest.runWithAdapter(adapter(backend, spawns), 'x', {
      executionId: `exec-${backend}-divergence`, threadId: `thr-${backend}-divergence`,
      rootThreadId: `thr-${backend}-divergence`, parentThreadId: null,
      taskId: null, taskGeneration: null, templateName: 'benchmark-direct',
      agentSlotId: 'benchmark-direct', stage: null, profileName: resolvedProfile.name,
      resolvedProfileConfig: resolvedProfile, identityDirective: '', preparedSpawnConfig: config,
    }, {
      model: resolvedProfile.model, backend, mode: resolvedProfile.mode,
      provider: resolvedProfile.provider, extraEnv: {}, extraOption: {},
      claudeBackend: resolvedProfile.claudeBackend, thinking: resolvedProfile.thinking,
    }, backend === 'claude' ? 'http://proxy.invalid' : undefined), /model.*drift|diverge/i);
    assert.equal(spawns.length, 0);
  });
}

test('does not expose mutable in-memory identity records', async () => {
  initialize('claude');
  const resolvedProfile = profile('claude');
  await facadeTest.runWithAdapter(adapter('claude', []), 'x', {
    executionId: 'exec-immutable', threadId: 'thr-immutable', rootThreadId: 'thr-immutable',
    parentThreadId: null, taskId: null, taskGeneration: null,
    templateName: 'benchmark-direct', agentSlotId: 'benchmark-direct', stage: null,
    profileName: resolvedProfile.name, resolvedProfileConfig: resolvedProfile,
    identityDirective: '', tools: 'Read', pluginDirs: [], mcpComposition: 'none',
    disableHooks: true, loadCortexRules: false,
  }, {
    model: resolvedProfile.model, backend: 'claude', mode: resolvedProfile.mode,
    provider: resolvedProfile.provider, extraEnv: {}, extraOption: {}, claudeBackend: 'print',
    thinking: resolvedProfile.thinking,
  }, 'http://proxy.invalid').promise;
  const record = getProductionAttemptIdentity('exec-immutable');
  assert.ok(record);
  assert.throws(() => { (record as { role: string }).role = 'mutated'; }, TypeError);
  assert.equal(getProductionAttemptIdentity('exec-immutable')?.role, 'benchmark-direct');
});

test('fails closed for unapplied output caps and incomplete task-dispatch identity', () => {
  initialize('pi', 4096);
  const piProfile = profile('pi');
  const piConfig = {
    model: piProfile.model, backend: 'pi' as const, mode: piProfile.mode,
    provider: piProfile.provider, extraEnv: {}, extraOption: {}, thinking: piProfile.thinking,
  };
  const baseOptions = {
    executionId: 'exec-cap', threadId: 'thr-cap', rootThreadId: 'thr-cap',
    parentThreadId: null, taskId: null, taskGeneration: null,
    templateName: 'benchmark-direct', agentSlotId: 'benchmark-direct', stage: null,
    profileName: piProfile.name, resolvedProfileConfig: piProfile,
    identityDirective: '', tools: 'Read', pluginDirs: [], mcpComposition: 'none' as const,
    disableHooks: true, loadCortexRules: false,
  };
  assert.throws(() => facadeTest.runWithAdapter(
    adapter('pi', []), 'x', baseOptions, piConfig, undefined,
  ), /output token.*drift/i);

  resetProductionAttemptIdentity();
  initialize('claude');
  const claudeProfile = profile('claude');
  assert.throws(() => facadeTest.runWithAdapter(adapter('claude', []), 'x', {
    ...baseOptions, executionId: 'exec-task-incomplete', taskId: 'a1b2',
    profileName: claudeProfile.name, resolvedProfileConfig: claudeProfile,
  }, {
    model: claudeProfile.model, backend: 'claude', mode: claudeProfile.mode,
    provider: claudeProfile.provider, extraEnv: {}, extraOption: {}, claudeBackend: 'print',
    thinking: claudeProfile.thinking,
  }, 'http://proxy.invalid'), /task project|dispatch generation/i);
});

test('refuses reuse of an execution identity with a changed resolved spawn surface', async () => {
  initialize('claude');
  const spawns: AgentSpawnConfig[] = [];
  const resolvedProfile = profile('claude');
  const options = {
    executionId: 'exec-reused', threadId: 'thr-reused', rootThreadId: 'thr-reused',
    parentThreadId: null, taskId: null, taskGeneration: null,
    templateName: 'benchmark-direct', agentSlotId: 'benchmark-direct', stage: null,
    profileName: resolvedProfile.name, resolvedProfileConfig: resolvedProfile,
    identityDirective: '', tools: 'Read', pluginDirs: [], mcpComposition: 'none' as const,
    disableHooks: true, loadCortexRules: false,
  };
  const config = {
    model: resolvedProfile.model, backend: 'claude' as const, mode: resolvedProfile.mode,
    provider: resolvedProfile.provider, extraEnv: {}, extraOption: {}, claudeBackend: 'print' as const,
    thinking: resolvedProfile.thinking,
  };
  await facadeTest.runWithAdapter(
    adapter('claude', spawns), 'x', options, config, 'http://proxy.invalid',
  ).promise;
  assert.throws(() => facadeTest.runWithAdapter(
    adapter('claude', spawns), 'x', { ...options, tools: 'Write' }, config, 'http://proxy.invalid',
  ), /identity changed|baseline.*drift/i);
  assert.equal(spawns.length, 1);
});

test('rejects incomplete persisted identity records on reload', () => {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), `${JSON.stringify({
    schema_version: 'cortex-production-attempt-identity/2',
    execution_id: 'exec-incomplete', attempt_id: 'attempt-exec-incomplete',
  })}\n`);
  assert.throws(() => initializeProductionAttemptIdentity({
    storePath: storePath(), configurationRevision: () => ({ ...revision }),
  }), /store invalid/i);
});

test('rejects malformed typed evidence context before spawn', () => {
  initialize('pi');
  activeEvidence = {
    ...evidence('pi'),
    model_execution: { cli_name: 'pi' },
  } as unknown as ProductionBenchmarkEvidenceContext;
  const resolvedProfile = profile('pi');
  assert.throws(() => facadeTest.runWithAdapter(adapter('pi', []), 'x', {
    executionId: 'exec-context-invalid', threadId: 'thr-context-invalid',
    rootThreadId: 'thr-context-invalid', parentThreadId: null, taskId: null,
    taskGeneration: null, templateName: 'benchmark-direct', agentSlotId: 'benchmark-direct',
    stage: null, profileName: resolvedProfile.name, resolvedProfileConfig: resolvedProfile,
    identityDirective: '', tools: 'Read', pluginDirs: [], mcpComposition: 'none',
    disableHooks: true, loadCortexRules: false,
  }, {
    model: resolvedProfile.model, backend: 'pi', mode: resolvedProfile.mode,
    provider: resolvedProfile.provider, extraEnv: {}, extraOption: {}, thinking: resolvedProfile.thinking,
  }, undefined), /evidence context.*invalid|model_execution/i);
});
