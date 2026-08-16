// input:  typed thread evidence context and production facade seam
// output: context-gated attempt identity and root baseline proofs
// pos:    Verifies production benchmark evidence context behavior
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
  getProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  resetProductionAttemptIdentity,
} from '../../../src/domain/agent-run/production-attempt-identity.js';
import { _test as facadeTest } from '../../../src/domain/agents/facade.js';
import type { ResolvedProfileConfig } from '../../../src/domain/agents/profile-manager.js';
import type { RunAgentOptions } from '../../../src/domain/agents/spawn-config.js';

const SHA = 'c'.repeat(64);
let root: string;
let storePath: string;
let revision: { profiles: number; threads: number };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-evidence-context-'));
  storePath = path.join(root, 'data', 'attempt-identities.jsonl');
  revision = { profiles: 1, threads: 1 };
  resetProductionAttemptIdentity();
  initializeProductionAttemptIdentity({
    storePath,
    configurationRevision: () => ({ ...revision }),
  });
});

afterEach(() => {
  resetProductionAttemptIdentity();
  fs.rmSync(root, { recursive: true, force: true });
});

function evidence(backend: Backend): ProductionBenchmarkEvidenceContext {
  return {
    schema_version: 'cortex-production-benchmark-evidence-context/1',
    trial_id: `trial-${backend}`,
    root_run_id: `root-${backend}`,
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

function result(): AgentResult {
  return {
    sessionId: 'backend-session', finalOutput: 'ok', num_turns: 1,
    total_cost_usd: 0, rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
  };
}

function process(): AgentProcess {
  return {
    sessionKey: 'fixture', sessionId: 'backend-session', send: async () => result(),
    events: { async *[Symbol.asyncIterator]() {} }, close: async () => {}, kill: () => true,
  };
}

function adapter(
  backend: Backend,
  spawns: AgentSpawnConfig[],
  expectedPrepared?: AgentSpawnConfig,
): AgentAdapter {
  return {
    backend, capabilities: new Set(),
    spawn(config) {
      if (expectedPrepared) assert.equal(config, expectedPrepared);
      spawns.push(config);
      return process();
    },
    close: async () => {}, kill: () => false, listSessions: () => [],
  };
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
  preparedSpawnConfig?: AgentSpawnConfig;
}

function runAttempt(
  backend: Backend,
  spawns: AgentSpawnConfig[],
  input: AttemptOptions,
): ReturnType<typeof facadeTest.runWithAdapter> {
  const resolved = profile(backend);
  const options: RunAgentOptions = {
    executionId: input.executionId,
    threadId: input.threadId,
    rootThreadId: input.rootThreadId ?? input.threadId,
    parentThreadId: input.parentThreadId ?? null,
    taskId: input.taskId ?? null,
    taskProject: input.taskProject ?? null,
    taskGeneration: input.taskGeneration ?? null,
    templateName: input.template ?? 'benchmark-direct',
    agentSlotId: input.role ?? 'benchmark-direct',
    stage: input.stage ?? null,
    profileName: resolved.name,
    resolvedProfileConfig: resolved,
    productionBenchmarkEvidenceContext: input.context,
    identityDirective: 'Resolved directive',
    tools: input.tools ?? 'Read',
    pluginDirs: [], mcpComposition: 'none', disableHooks: true, loadCortexRules: false,
    preparedSpawnConfig: input.preparedSpawnConfig,
  };
  return facadeTest.runWithAdapter(adapter(backend, spawns, input.preparedSpawnConfig), 'work', options, {
    model: resolved.model, backend, mode: resolved.mode, provider: resolved.provider,
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
  }, backend === 'claude' ? 'http://proxy.invalid' : undefined);
}

for (const backend of ['claude', 'pi'] as const) {
  test(`${backend} direct, coder-review, and dispatched manager attempts use typed context`, async () => {
    const context = evidence(backend);
    const spawns: AgentSpawnConfig[] = [];
    await runAttempt(backend, spawns, {
      executionId: `${backend}-direct`, threadId: `${backend}-direct-thread`, context,
    }).promise;
    await runAttempt(backend, spawns, {
      executionId: `${backend}-coder`, threadId: `${backend}-coder-thread`, context,
      template: 'benchmark-coder-review', role: 'benchmark-coder', stage: 'implement',
    }).promise;
    await runAttempt(backend, spawns, {
      executionId: `${backend}-manager`, threadId: `${backend}-manager-thread`, context,
      template: 'benchmark-manager', role: 'benchmark-manager', taskId: 'a1b2',
      taskProject: 'atlas', taskGeneration: 'generation-1',
    }).promise;

    assert.equal(spawns.length, 3);
    for (const executionId of [`${backend}-direct`, `${backend}-coder`, `${backend}-manager`]) {
      assert.equal(getProductionAttemptIdentity(executionId)?.execution_id, executionId);
    }
  });
}

test('two and three executions in one thread receive distinct stable attempts', async () => {
  const context = evidence('claude');
  const spawns: AgentSpawnConfig[] = [];
  for (const suffix of ['direct-1', 'direct-2']) {
    await runAttempt('claude', spawns, {
      executionId: suffix, threadId: 'thread-two', context,
    }).promise;
  }
  for (const [suffix, role, tools] of [
    ['coder', 'benchmark-coder', 'Read,Write'],
    ['reviewer', 'benchmark-reviewer', 'Read'],
    ['fixer', 'benchmark-fixer', 'Read,Write'],
  ] as const) {
    await runAttempt('claude', spawns, {
      executionId: suffix, threadId: 'thread-three', context,
      template: 'benchmark-coder-review', role, tools,
    }).promise;
  }

  const two = ['direct-1', 'direct-2'].map(id => getProductionAttemptIdentity(id)!);
  const three = ['coder', 'reviewer', 'fixer'].map(id => getProductionAttemptIdentity(id)!);
  assert.equal(new Set(two.map(row => row.attempt_id)).size, 2);
  assert.equal(new Set(three.map(row => row.attempt_id)).size, 3);
  assert.ok(two.every(row => row.root_attempt_id === two[0].attempt_id));
  assert.ok(three.every(row => row.root_attempt_id === three[0].attempt_id));
});

test('retry, resumed, and nested executions cannot collide with the root attempt', async () => {
  const context = evidence('claude');
  const spawns: AgentSpawnConfig[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'root-first', threadId: 'root-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-coder',
  }).promise;
  await runAttempt('claude', spawns, {
    executionId: 'root-retry', threadId: 'root-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-coder',
  }).promise;

  resetProductionAttemptIdentity();
  initializeProductionAttemptIdentity({ storePath });
  await runAttempt('claude', spawns, {
    executionId: 'root-resumed', threadId: 'root-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-reviewer',
  }).promise;
  await runAttempt('claude', spawns, {
    executionId: 'nested-manager', threadId: 'child-thread', rootThreadId: 'root-thread',
    parentThreadId: 'root-thread', context,
    template: 'benchmark-manager', role: 'benchmark-manager',
  }).promise;

  const records = ['root-first', 'root-retry', 'root-resumed', 'nested-manager']
    .map(id => getProductionAttemptIdentity(id)!);
  assert.equal(new Set(records.map(row => row.attempt_id)).size, records.length);
  assert.ok(records.every(row => row.root_attempt_id === records[0].attempt_id));
});

test('absence disables observability while malformed context refuses before spawn', async () => {
  const spawns: AgentSpawnConfig[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'without-context', threadId: 'without-context',
  }).promise;
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

test('root baseline refuses drift and the exact prepared spawn object reaches the adapter', async () => {
  const context = evidence('claude');
  const spawns: AgentSpawnConfig[] = [];
  const prepared: AgentSpawnConfig = {
    sessionId: null, sessionKey: 'prepared', resume: false, model: 'claude-fixture',
    thinking: undefined, mcpComposition: 'none', rawTools: 'Read', disableHooks: true,
    anthropicBaseUrl: 'http://proxy.invalid',
  };
  await runAttempt('claude', spawns, {
    executionId: 'baseline', threadId: 'baseline-thread', context, preparedSpawnConfig: prepared,
  }).promise;
  assert.ok(fs.existsSync(storePath));

  const drifted: AgentSpawnConfig = { ...prepared, rawTools: 'Write' };
  assert.throws(() => runAttempt('claude', spawns, {
    executionId: 'drifted', threadId: 'baseline-thread', context,
    preparedSpawnConfig: drifted,
  }), /baseline|role.*drift|identity changed/i);
  assert.equal(spawns.length, 1);
});
