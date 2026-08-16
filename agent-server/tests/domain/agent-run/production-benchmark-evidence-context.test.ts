// input:  typed thread evidence context and production facade seam
// output: context-gated identity, spawn linkage, and strict reads
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
  listProductionAttemptIdentities,
  readProductionAttemptIdentity,
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
    const spawns: AgentSpawnConfig[] = [];
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
      }).promise;
      assert.equal(getProductionAttemptIdentity(executionId)?.execution_id, executionId);
    }
    assert.equal(spawns.length, 3);
  });
}

test('coder, reviewer, and fixer form the exact same-thread spawn chain', async () => {
  const context = evidence('claude', 'coder-review-fix');
  const spawns: AgentSpawnConfig[] = [];
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
  const spawns: AgentSpawnConfig[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'manager-first', threadId: 'manager-thread', context,
    template: 'benchmark-manager', role: 'benchmark-manager',
  }).promise;
  const first = readProductionAttemptIdentity('manager-first');

  await Promise.all(['child-a', 'child-b'].map(async (executionId) => runAttempt('claude', spawns, {
    executionId, threadId: `${executionId}-thread`, rootThreadId: 'manager-thread',
    parentThreadId: 'manager-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-coder',
  }).promise));
  assert.equal(readProductionAttemptIdentity('child-a').spawn_parent_attempt_id, first.attempt_id);
  assert.equal(readProductionAttemptIdentity('child-b').spawn_parent_attempt_id, first.attempt_id);

  await runAttempt('claude', spawns, {
    executionId: 'child-a-review', threadId: 'child-a-thread', rootThreadId: 'manager-thread',
    parentThreadId: 'manager-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-reviewer',
  }).promise;
  assert.equal(
    readProductionAttemptIdentity('child-a-review').spawn_parent_attempt_id,
    readProductionAttemptIdentity('child-a').attempt_id,
  );

  await runAttempt('claude', spawns, {
    executionId: 'manager-resumed', threadId: 'manager-thread', context,
    template: 'benchmark-manager', role: 'benchmark-manager',
  }).promise;
  const resumed = readProductionAttemptIdentity('manager-resumed');
  await runAttempt('claude', spawns, {
    executionId: 'dispatch-child', threadId: 'dispatch-child-thread',
    rootThreadId: 'manager-thread', parentThreadId: 'manager-thread', context,
    template: 'benchmark-coder-review', role: 'benchmark-coder',
    taskId: 'b2c3', taskProject: 'atlas', taskGeneration: 'generation-child',
  }).promise;
  const dispatched = readProductionAttemptIdentity('dispatch-child');
  assert.equal(dispatched.spawn_parent_attempt_id, resumed.attempt_id);
  assert.equal(dispatched.task_id, 'b2c3');
  assert.equal(dispatched.dispatch_generation, 'generation-child');
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

test('fails closed when a child first execution cannot resolve its parent attempt', async () => {
  const context = evidence('claude', 'missing-parent');
  const spawns: AgentSpawnConfig[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'root-existing', threadId: 'root-existing-thread', context,
  }).promise;
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
  const spawns: AgentSpawnConfig[] = [];
  await runAttempt('claude', spawns, {
    executionId: 'tamper-one', threadId: 'tamper-thread-one',
    context: evidence('claude', 'tamper-one'),
  }).promise;
  await runAttempt('claude', spawns, {
    executionId: 'tamper-two', threadId: 'tamper-thread-two',
    context: evidence('claude', 'tamper-two'),
  }).promise;
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
