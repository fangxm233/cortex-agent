// input:  materialized production home and host-owned trial identities
// output: real production journal, identity and exported v2 evidence bytes
// pos:    Cross-language production finalization fixture
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';

import type { AgentSpawnConfig } from '../../../../agent-server/src/agent-adapter/types.js';
import type { ThreadRecord } from '../../../../agent-server/src/core/types/thread-types.js';
import {
  createProductionAttemptJournalSink,
  getProductionAttemptJournal,
} from '../../../../agent-server/src/domain/agent-run/production-attempt-journal.js';
import {
  freezeProductionAttemptIdentity,
  initializeProductionAttemptIdentity,
  listProductionAttemptIdentities,
} from '../../../../agent-server/src/domain/agent-run/production-attempt-identity.js';
import type { ResolvedProfileConfig } from '../../../../agent-server/src/domain/agents/profile-manager.js';
import type { RunAgentOptions } from '../../../../agent-server/src/domain/agents/spawn-config.js';
import type { ProxyExport } from '../../../../agent-server/src/domain/benchmark/accounting-reconciliation.js';
import {
  exportProductionBenchmarkEvidence,
  type ProductionEvidenceExportInput,
  type ProductionEvidenceSources,
} from '../../../../agent-server/src/domain/benchmark/production-evidence-export.js';
import type { CostEntry } from '../../../../agent-server/src/domain/costs/cost-tracker.js';
import type { ExecutionRecord } from '../../../../agent-server/src/store/execution-repo.js';

interface FixtureInput {
  home: string;
  outputDirectory: string;
  trialId: string;
  rootRunId: string;
  armName: string;
  armCanonicalSha256: string;
  bundleManifestHash: string;
  failed: boolean;
}

const THREAD_ID = 'thr_0123abcd';
const EXECUTION_ID = 'exec-production-finalization';
const ROLE = 'benchmark-direct';
const MODEL = 'deepseek-v4-flash';
const STARTED_AT = new Date(Date.now() - 1_000).toISOString();
const ENDED_AT = new Date(Date.now() + 1_000).toISOString();

function readInput(): FixtureInput {
  const file = process.argv[2];
  if (!file) throw new Error('fixture input path is required');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureInput;
}

function agentConfig(input: FixtureInput): Record<string, unknown> {
  const file = path.join(
    input.home, 'config/thread-templates/agents/benchmark-direct.json',
  );
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function spawnConfig(input: FixtureInput): AgentSpawnConfig {
  const config = agentConfig(input);
  const tools = String(config.tools).split(',');
  return {
    sessionId: null, sessionKey: 'production-finalization-fixture', resume: false,
    cwd: '/workspace', model: MODEL, thinking: null,
    piProvider: 'deepseek', piGatewayBaseUrl: `http://${input.trialId}.proxy.invalid:49152`,
    piModelMaxTokens: 65_536,
    systemPrompt: fs.readFileSync(
      path.join(input.home, 'prompts/systemPrompts/benchmark-direct.md'), 'utf8',
    ),
    tools, pluginDirs: [], pluginSkillDirs: [],
    mcpComposition: 'none', mcpToolAllowlist: [],
  };
}

function profile(): ResolvedProfileConfig {
  return {
    name: ROLE, model: MODEL, backend: 'pi', mode: 'trial', provider: 'deepseek',
    fallback: [], extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
  };
}

function evidenceContext(input: FixtureInput) {
  return {
    schema_version: 'cortex-production-benchmark-evidence-context/1' as const,
    trial_id: input.trialId, root_run_id: input.rootRunId,
    bundle_manifest_hash: input.bundleManifestHash,
    model_execution: {
      model_alias_policy: { policy: 'exact' }, cli_name: 'pi' as const,
      cli_version: '0.82.1', max_output_tokens: 65_536,
    },
  };
}

function runOptions(input: FixtureInput): RunAgentOptions {
  return {
    executionId: EXECUTION_ID, threadId: THREAD_ID, rootThreadId: THREAD_ID,
    parentThreadId: null, templateName: ROLE, agentSlotId: ROLE, stage: null,
    identityDirective: fs.readFileSync(
      path.join(input.home, 'prompts/directives/benchmark-direct.md'), 'utf8',
    ),
    resolvedProfileConfig: profile(), productionBenchmarkEvidenceContext: evidenceContext(input),
  };
}

function proxyExport(input: FixtureInput): ProxyExport {
  const unavailable = { status: 'unavailable', reason: 'counter_unreadable' } as const;
  return {
    schema_version: 'cortex-bench-proxy-export/1', trial_id: input.trialId,
    adapter_id: 'proxy-production-fixture', requests: unavailable,
    cached_tokens: unavailable, input_tokens: unavailable, output_tokens: unavailable,
    audit_log: unavailable, lease_echo: unavailable, source: 'proxy_export',
  };
}

function execution(input: FixtureInput): ExecutionRecord {
  const status = input.failed ? 'failed' : 'completed';
  return {
    id: EXECUTION_ID, kind: 'thread', status, channel: 'benchmark', project: 'general',
    source: { trigger: 'benchmark' }, backend: 'pi', billingMode: 'api',
    session: { sessionId: null }, thread: { threadId: THREAD_ID, agentSlotId: ROLE },
    dispatch: null, scheduleTaskId: null,
    runtime: { startedAt: STARTED_AT, updatedAt: ENDED_AT, endedAt: ENDED_AT },
    metrics: { costUsd: 0, numTurns: 1, durationS: 2 }, gpu: null,
    text: { label: ROLE, finalOutput: null, error: input.failed ? 'rate limited' : null },
  };
}

function thread(input: FixtureInput): ThreadRecord {
  return {
    id: THREAD_ID, status: input.failed ? 'failed' : 'completed',
    abortReason: null, endedAt: ENDED_AT,
    steps: input.failed ? [] : [{ executionId: EXECUTION_ID }],
  } as ThreadRecord;
}

function cost(input: FixtureInput, attemptId: string): CostEntry {
  return {
    timestamp: ENDED_AT, project: 'general', trigger: 'thread', cost_usd: 0,
    num_turns: 1, duration_s: 2, backend: 'pi', mode: 'api', source: 'agent',
    input_tokens: 3, output_tokens: 2, prompt_tokens: 3,
    cache_read_tokens: 0, cache_creation_tokens: 0, provider_requests: 1,
    execution_id: EXECUTION_ID, thread_id: THREAD_ID, parent_thread_id: null,
    root_thread_id: THREAD_ID, task_id: input.trialId, task_project: null,
    dispatch_generation: null, attempt_id: attemptId, root_attempt_id: attemptId,
    trial_id: input.trialId, root_run_id: input.rootRunId,
  };
}

function sources(
  input: FixtureInput, executionRecord: ExecutionRecord,
  threadRecord: ThreadRecord, costRecord: CostEntry,
): ProductionEvidenceSources {
  return {
    flush: async () => {},
    listIdentities: scope => listProductionAttemptIdentities(scope),
    getJournal: id => id === EXECUTION_ID ? getProductionAttemptJournal(id) : null,
    getExecution: id => id === EXECUTION_ID ? executionRecord : null,
    getThread: id => id === THREAD_ID ? threadRecord : null,
    readCosts: async () => [costRecord], readTopology: () => [], readTasks: () => [],
  };
}

async function main(): Promise<void> {
  const input = readInput();
  initializeProductionAttemptIdentity({
    storePath: path.join(input.home, 'data/benchmark-attempt-identities.jsonl'),
  });
  const spawn = spawnConfig(input);
  const options = runOptions(input);
  const identity = freezeProductionAttemptIdentity({
    adapterBackend: 'pi', spawnConfig: spawn, options, resolvedProfile: profile(),
  });
  if (!identity) throw new Error('production identity was not frozen');
  const sink = createProductionAttemptJournalSink({
    identity, spawnConfig: spawn,
    canonicalInstruction: options.identityDirective ?? '', message: 'Solve the task.',
  });
  sink.onEvent({ type: 'session_started', sessionId: 'pi-production-session' });
  sink.onEvent(input.failed
    ? { type: 'rate_limit', raw: { status: 429 } }
    : { type: 'assistant_text', text: 'done', model: MODEL });
  sink.onClose?.();
  const exportInput: ProductionEvidenceExportInput = {
    outputDirectory: input.outputDirectory, project: 'general',
    trialId: input.trialId, rootRunId: input.rootRunId,
    armName: input.armName, armCanonicalSha256: input.armCanonicalSha256,
    bundleManifestHash: input.bundleManifestHash, mode: 'direct',
    expectedRoles: [ROLE], managerQa: null,
    limits: { max_task_depth: 0, max_tasks: 0 }, proxyExport: proxyExport(input),
  };
  const executionRecord = execution(input);
  const threadRecord = thread(input);
  await exportProductionBenchmarkEvidence(
    exportInput, sources(input, executionRecord, threadRecord, cost(input, identity.attempt_id)),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
