// input:  production facade, spawn-linked identity, cost repo
// output: concurrent attempt accounting persistence and reload proofs
// pos:    Verifies durable request and token attribution
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import type {
  AgentAdapter, AgentProcess, AgentSpawnConfig, Backend, NormalizedEvent,
} from '../../../src/agent-adapter/index.js';
import type { AgentResult } from '../../../src/core/types/agent-types.js';
import type { ProductionBenchmarkEvidenceContext } from '../../../src/core/types/thread-types.js';
import {
  getProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  resetProductionAttemptIdentity,
} from '../../../src/domain/agent-run/production-attempt-identity.js';
import { _test as facadeTest } from '../../../src/domain/agents/facade.js';
import type { ResolvedProfileConfig } from '../../../src/domain/agents/profile-manager.js';
import { getCostSummary } from '../../../src/domain/costs/cost-tracker.js';
import { CostRepo, costRepo } from '../../../src/store/cost-repo.js';

const SHA = 'b'.repeat(64);
let root: string;
let costsPath: string;
let evidenceContext: ProductionBenchmarkEvidenceContext;
const originalCostsPath = process.env.CORTEX_COSTS_FILE;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-accounting-'));
  costsPath = path.join(root, 'data', 'costs.jsonl');
  process.env.CORTEX_COSTS_FILE = costsPath;
  costRepo._testReset();
  resetProductionAttemptIdentity();
});

afterEach(async () => {
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

function result(): AgentResult {
  return {
    sessionId: 'backend-session', finalOutput: 'ok', num_turns: 1,
    total_cost_usd: 0.02, rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
  };
}

function adapter(backend: Backend, event: NormalizedEvent): AgentAdapter {
  return {
    backend, capabilities: new Set(),
    spawn(_config: AgentSpawnConfig): AgentProcess {
      return {
        sessionKey: 'fixture', sessionId: 'backend-session',
        send: async () => result(),
        events: { async *[Symbol.asyncIterator]() { yield event; } },
        close: async () => {}, kill: () => true,
      };
    },
    close: async () => {}, kill: () => false, listSessions: () => [],
  };
}

function accountingEvent(
  backend: Backend,
  values: {
    input: number | null; output: number | null;
    cacheRead: number | null; cacheCreation: number | null;
    requests: number | null; cost?: number | null;
  },
): NormalizedEvent {
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
  event: NormalizedEvent,
): Promise<void> {
  const resolved = profile(backend);
  const isRoot = suffix === 'zero';
  await facadeTest.runWithAdapter(adapter(backend, event), 'work', {
    trackSessionId: `session-${suffix}`, executionId: `exec-${suffix}`,
    threadId: `thr-${suffix}`, rootThreadId: 'thr-zero',
    parentThreadId: isRoot ? null : 'thr-zero',
    taskId: `task-${suffix}`, taskProject: 'cortex-self', taskGeneration: `generation-${suffix}`,
    templateName: 'benchmark-direct', agentSlotId: 'benchmark-direct', stage: null,
    profileName: resolved.name, resolvedProfileConfig: resolved,
    productionBenchmarkEvidenceContext: evidenceContext,
    identityDirective: '', tools: 'Read', pluginDirs: [], mcpComposition: 'none',
    disableHooks: true, loadCortexRules: false,
    project: 'cortex-self', trigger: 'thread',
  }, {
    model: resolved.model, backend, mode: resolved.mode, provider: resolved.provider,
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
  }, backend === 'claude' ? 'http://proxy.invalid' : undefined).promise;
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
