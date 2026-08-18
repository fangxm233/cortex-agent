// input:  production attempt stores, topology ledger and evidence exporter
// output: real-root production evidence fixtures for boundary tests
// pos:    Builds durable thread/task evidence without standalone roots
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { NormalizedEvent } from '../../../src/agent-adapter/normalize/event-types.js';
import type { AgentSpawnConfig, Backend } from '../../../src/agent-adapter/types.js';
import type { ThreadRecord } from '../../../src/core/types/thread-types.js';
import type { Task } from '../../../src/core/task-parser.js';
import {
  ProductionAttemptIdentityRepo, type ProductionAttemptIdentityRecord,
} from '../../../src/domain/agent-run/production-attempt-identity.js';
import { computeRoleToolSurfaceHash } from '../../../src/domain/agent-run/identity.js';
import {
  createProductionAttemptJournalSink, getProductionAttemptJournal,
  initializeProductionAttemptJournals, resetProductionAttemptJournals,
  type ProductionAttemptJournalRecord,
} from '../../../src/domain/agent-run/production-attempt-journal.js';
import { roleSurfaceFromSpawnConfig } from '../../../src/domain/agent-run/role-surface.js';
import type { ProxyExport } from '../../../src/domain/benchmark/accounting-reconciliation.js';
import {
  exportProductionBenchmarkEvidence,
  type ProductionEvidenceExportInput,
  type ProductionEvidenceExportResult,
  type ProductionEvidenceSources,
} from '../../../src/domain/benchmark/production-evidence-export.js';
import type { CompositeManifest } from '../../../src/domain/benchmark/composite-manifest.js';
import type { CostEntry } from '../../../src/domain/costs/cost-tracker.js';
import {
  readProductionTopologyFacts, recordProductionTopologyFact,
  type ProductionTopologyFact,
} from '../../../src/domain/tasks/production-topology-ledger.js';
import type { ExecutionRecord } from '../../../src/store/execution-repo.js';

const HASH = 'a'.repeat(64);
const BUNDLE_HASH = 'b'.repeat(64);
const STARTED_AT = '2020-01-01T00:00:00.000Z';
const ENDED_AT = '2099-01-01T00:00:00.000Z';

export type ProductionBoundaryScenario =
  | 'direct'
  | 'coder-audit'
  | 'coder-fix'
  | 'manager-qa-off'
  | 'manager-qa-on'
  | 'manager-history';

export type ProductionBoundaryAccounting =
  | 'complete'
  | 'cached'
  | 'unavailable'
  | 'partial'
  | 'cost-only';

export interface ProductionBoundaryOptions {
  scenario?: ProductionBoundaryScenario;
  backend?: Backend;
  accounting?: ProductionBoundaryAccounting;
  event?: NormalizedEvent;
  events?: readonly NormalizedEvent[];
}

interface AttemptSpec {
  executionId: string;
  threadId: string;
  role: string;
  taskId: string;
  parentThreadId?: string | null;
  rootThreadId?: string;
  taskProject?: string | null;
  generation?: string | null;
  status?: 'completed' | 'failed' | 'cancelled';
  threadStatus?: ThreadRecord['status'];
  abortReason?: string | null;
  rateLimited?: boolean;
}

interface AttemptFixture {
  identity: ProductionAttemptIdentityRecord;
  journal: ProductionAttemptJournalRecord;
  execution: ExecutionRecord;
  thread: ThreadRecord;
  cost: CostEntry;
}

export interface PublishedProductionBoundary {
  readonly outputDirectory: string;
  readonly result: ProductionEvidenceExportResult;
  readonly composite: CompositeManifest;
  readonly terminalManifests: readonly Record<string, unknown>[];
  readonly journalRecords: readonly Record<string, unknown>[];
}

export interface ProductionBoundaryFixture {
  readonly root: string;
  readonly project: string;
  readonly input: ProductionEvidenceExportInput;
  readonly sources: ProductionEvidenceSources;
  readonly attempts: readonly AttemptFixture[];
  readonly facts: readonly ProductionTopologyFact[];
  readonly tasks: readonly Task[];
  publish(): Promise<PublishedProductionBoundary>;
  cleanup(): void;
}

function proxy(trialId: string): ProxyExport {
  const unavailable = { status: 'unavailable', reason: 'counter_unreadable' } as const;
  return {
    schema_version: 'cortex-bench-proxy-export/1', trial_id: trialId, adapter_id: 'proxy-1',
    requests: { status: 'available', value: 1 }, cached_tokens: unavailable,
    input_tokens: { status: 'available', value: 10 },
    output_tokens: { status: 'available', value: 4 }, audit_log: unavailable,
    lease_echo: unavailable, source: 'proxy_export',
  };
}

function costValues(accounting: ProductionBoundaryAccounting) {
  const values = {
    complete: [10, 4, 12, 2, null, 1, 0.25],
    cached: [10, 4, 20, 7, 3, 1, 0.25],
    unavailable: [null, null, null, null, null, null, null],
    partial: [10, 4, null, null, null, 1, 0.25],
    'cost-only': [null, null, null, null, null, 1, 0.625],
  }[accounting];
  return {
    input_tokens: values[0], output_tokens: values[1], prompt_tokens: values[2],
    cache_read_tokens: values[3], cache_creation_tokens: values[4],
    provider_requests: values[5], cost_usd: values[6],
  } as const;
}

function costEvent(accounting: ProductionBoundaryAccounting): NormalizedEvent {
  const values = costValues(accounting);
  return {
    type: 'cost_record', provider: 'anthropic', model: 'model-native',
    tokens_in: values.prompt_tokens, tokens_out: values.output_tokens,
    prompt_tokens: values.prompt_tokens, cached_tokens: values.cache_read_tokens,
    input_tokens: values.input_tokens, output_tokens: values.output_tokens,
    cache_read_tokens: values.cache_read_tokens,
    cache_creation_tokens: values.cache_creation_tokens,
    provider_requests: values.provider_requests, cost_usd: values.cost_usd,
  };
}

function inputFor(
  outputDirectory: string, project: string, trialId: string, rootRunId: string,
  scenario: ProductionBoundaryScenario, roles: readonly string[],
): ProductionEvidenceExportInput {
  const manager = scenario.startsWith('manager');
  return {
    outputDirectory, project, trialId, rootRunId, armName: `arm-${scenario}`,
    armCanonicalSha256: 'c'.repeat(64), bundleManifestHash: BUNDLE_HASH,
    mode: manager ? 'manager' : scenario === 'direct' ? 'direct' : 'coder-review',
    expectedRoles: roles,
    managerQa: manager ? (scenario === 'manager-qa-on' ? 'on' : 'off') : null,
    proxyExport: proxy(trialId),
  };
}

function execution(spec: AttemptSpec): ExecutionRecord {
  const status = spec.status ?? 'completed';
  return {
    id: spec.executionId, kind: 'thread', status, channel: 'benchmark',
    project: spec.taskProject ?? 'cortex-self', source: { trigger: 'benchmark' },
    backend: 'claude', billingMode: 'api', session: { sessionId: null },
    thread: { threadId: spec.threadId, agentSlotId: spec.role }, dispatch: null,
    scheduleTaskId: null, runtime: {
      startedAt: STARTED_AT, updatedAt: ENDED_AT, endedAt: ENDED_AT,
    },
    metrics: { costUsd: status === 'completed' ? 0.25 : null, numTurns: 1, durationS: 2 },
    gpu: null, text: {
      label: spec.role, finalOutput: null, error: status === 'failed' ? 'failed' : null,
    },
  };
}

function thread(spec: AttemptSpec): ThreadRecord {
  const status = spec.status ?? 'completed';
  return {
    id: spec.threadId,
    status: spec.threadStatus ?? (status === 'failed' ? 'failed' : 'completed'),
    abortReason: spec.abortReason ?? null, endedAt: ENDED_AT,
    steps: status === 'failed' ? [] : [{ executionId: spec.executionId }],
  } as ThreadRecord;
}

function cost(
  identity: ProductionAttemptIdentityRecord, accounting: ProductionBoundaryAccounting,
): CostEntry {
  return {
    timestamp: ENDED_AT, project: identity.task_project ?? 'cortex-self', trigger: 'thread',
    num_turns: 1, duration_s: 2, backend: identity.backend, mode: 'api', source: 'agent',
    ...costValues(accounting), execution_id: identity.execution_id,
    thread_id: identity.thread_id, parent_thread_id: identity.parent_thread_id,
    root_thread_id: identity.root_thread_id, task_id: identity.task_id,
    task_project: identity.task_project, dispatch_generation: identity.dispatch_generation,
    attempt_id: identity.attempt_id, root_attempt_id: identity.root_attempt_id,
    trial_id: identity.trial_id, root_run_id: identity.root_run_id,
  } as CostEntry;
}

function journalSpawnConfig(): AgentSpawnConfig {
  return {
    sessionId: null, sessionKey: 'production-boundary', resume: false,
    cwd: process.cwd(), systemPrompt: 'system', tools: ['Read'], pluginDirs: [],
  };
}

function journalRoleHash(): string {
  return computeRoleToolSurfaceHash(roleSurfaceFromSpawnConfig(
    journalSpawnConfig(), 'complete the task',
  ));
}

function writeJournal(
  identity: ProductionAttemptIdentityRecord, accounting: ProductionBoundaryAccounting,
  events: readonly NormalizedEvent[] | undefined,
): ProductionAttemptJournalRecord {
  const sink = createProductionAttemptJournalSink({
    identity, spawnConfig: journalSpawnConfig(),
    canonicalInstruction: 'complete the task', message: 'complete the task',
  });
  const observed = events ?? [identity.role === 'direct'
    ? costEvent(accounting)
    : { type: 'assistant_text', text: `${identity.role} done`, model: 'model-native' }];
  observed.forEach(event => sink.onEvent(event as NormalizedEvent));
  sink.onClose?.();
  const record = getProductionAttemptJournal(identity.execution_id);
  if (!record) throw new Error(`journal missing for ${identity.execution_id}`);
  return record;
}

function appendAttempt(
  repo: ProductionAttemptIdentityRepo, previous: readonly ProductionAttemptIdentityRecord[],
  rootRunId: string, trialId: string, backend: Backend,
  accounting: ProductionBoundaryAccounting, spec: AttemptSpec,
  events?: readonly NormalizedEvent[],
): AttemptFixture {
  const rootAttempt = previous[0];
  const sameThread = [...previous].reverse().find(item => item.thread_id === spec.threadId);
  const parentThread = spec.parentThreadId
    ? [...previous].reverse().find(item => item.thread_id === spec.parentThreadId) : null;
  const attemptId = `execution-${spec.executionId}`;
  const identity = repo.append({
    schema_version: 'cortex-production-attempt-identity/2', trial_id: trialId,
    root_run_id: rootRunId, attempt_id: attemptId,
    root_attempt_id: rootAttempt?.attempt_id ?? attemptId,
    spawn_parent_attempt_id: sameThread?.attempt_id ?? parentThread?.attempt_id ?? null,
    execution_id: spec.executionId, thread_id: spec.threadId,
    parent_thread_id: spec.parentThreadId ?? null,
    root_thread_id: spec.rootThreadId ?? spec.threadId,
    task_id: spec.taskId, task_project: spec.taskProject ?? null,
    dispatch_generation: spec.generation ?? null, template: `template-${spec.role}`,
    role: spec.role, stage: null, profile_name: 'benchmark', backend,
    provider: 'anthropic', requested_model: 'model-requested',
    model_execution_identity_hash: HASH, role_tool_surface_hash: journalRoleHash(),
    bundle_manifest_hash: BUNDLE_HASH, frozen_at: new Date().toISOString(),
  });
  return {
    identity, journal: writeJournal(identity, accounting, spec.rateLimited
      ? [{ type: 'rate_limit', raw: { status: 429 } }] : events),
    execution: { ...execution(spec), backend }, thread: thread(spec),
    cost: cost(identity, accounting),
  };
}

function recordFact(
  project: string,
  input: { kind: ProductionTopologyFact['kind'] } & Record<string, unknown>,
): ProductionTopologyFact {
  return recordProductionTopologyFact({ project, ...input } as Parameters<
    typeof recordProductionTopologyFact
  >[0]);
}

function managerFacts(
  project: string, qa: boolean, history: boolean,
): ProductionTopologyFact[] {
  const facts = [
    recordFact(project, { kind: 'decompose', actor_thread_id: 'thr-manager', parent_task_id: 'task-root', child_task_id: 'task-child' }),
    recordFact(project, { kind: 'dispatch', task_id: 'task-child', dispatch_generation: 'gen-child', thread_id: 'thr-child' }),
    recordFact(project, { kind: 'delivery', child_task_id: 'task-child', child_thread_id: 'thr-child', child_dispatch_generation: 'gen-child', parent_task_id: 'task-root', parent_thread_id: 'thr-manager', outcome: 'completed' }),
    recordFact(project, { kind: 'verdict', parent_task_id: 'task-root', manager_thread_id: 'thr-manager', child_task_id: 'task-child', child_thread_id: 'thr-child', child_dispatch_generation: 'gen-child', verdict: history ? 'rejected' : 'accepted', rework_round: history ? 1 : 0 }),
  ];
  if (qa) facts.push(
    recordFact(project, { kind: 'question', question_id: 'q1', asker_thread_id: 'thr-child', asker_task_id: 'task-child', manager_thread_id: 'thr-manager', origin_channel: null, question: 'clarify', projectable: true }),
    recordFact(project, { kind: 'answer', question_id: 'q1', answerer_thread_id: 'thr-manager', answerer_channel: null, asker_thread_id: 'thr-child', answer: 'answer', consumed_at: ENDED_AT, projectable: true }),
  );
  if (history) facts.push(
    recordFact(project, { kind: 'rework', task_id: 'task-child', rejected_thread_id: 'thr-child', rejected_dispatch_generation: 'gen-child', replacement_thread_id: 'thr-replacement', replacement_dispatch_generation: 'gen-replacement', rework_round: 1 }),
    recordFact(project, { kind: 'dispatch', task_id: 'task-child', dispatch_generation: 'gen-replacement', thread_id: 'thr-replacement' }),
    recordFact(project, { kind: 'delivery', child_task_id: 'task-child', child_thread_id: 'thr-replacement', child_dispatch_generation: 'gen-replacement', parent_task_id: 'task-root', parent_thread_id: 'thr-manager', outcome: 'blocked' }),
    recordFact(project, { kind: 'verdict', parent_task_id: 'task-root', manager_thread_id: 'thr-manager', child_task_id: 'task-child', child_thread_id: 'thr-replacement', child_dispatch_generation: 'gen-replacement', verdict: 'rejected', rework_round: 1 }),
  );
  return facts;
}

function task(id: string, parent: string | null): Task {
  return { id, parent, depends_on: [], project: 'cortex-self' } as Task;
}

function scenarioSpecs(
  scenario: ProductionBoundaryScenario, project: string,
): { specs: AttemptSpec[]; tasks: Task[] } {
  if (scenario === 'direct') {
    return { specs: [{ executionId: 'root', threadId: 'thr-root', role: 'direct', taskId: 'trial-production' }], tasks: [] };
  }
  if (scenario.startsWith('coder')) {
    const specs: AttemptSpec[] = [
      { executionId: 'root', threadId: 'thr-root', role: 'coder', taskId: 'trial-production' },
      { executionId: 'review', threadId: 'thr-root', role: 'reviewer', taskId: 'trial-production' },
    ];
    if (scenario === 'coder-fix') {
      specs.push({ executionId: 'fix', threadId: 'thr-root', role: 'fixer', taskId: 'trial-production' });
    }
    return { specs, tasks: [] };
  }
  const specs: AttemptSpec[] = [
    { executionId: 'manager', threadId: 'thr-manager', role: 'manager', taskId: 'task-root', taskProject: project, generation: 'gen-root' },
    { executionId: 'child', threadId: 'thr-child', role: 'coder', taskId: 'task-child', taskProject: project, generation: 'gen-child', parentThreadId: 'thr-manager', rootThreadId: 'thr-manager' },
    { executionId: 'review', threadId: 'thr-child', role: 'reviewer', taskId: 'task-child', taskProject: project, generation: 'gen-child', parentThreadId: 'thr-manager', rootThreadId: 'thr-manager', status: scenario === 'manager-history' ? 'failed' : 'completed' },
  ];
  if (scenario === 'manager-history') {
    specs.push({ executionId: 'replacement', threadId: 'thr-replacement', role: 'coder', taskId: 'task-child', taskProject: project, generation: 'gen-replacement', parentThreadId: 'thr-manager', rootThreadId: 'thr-manager', threadStatus: 'aborted', abortReason: 'blocked' });
  }
  return { specs, tasks: [task('task-root', null), task('task-child', 'task-root')] };
}

function readPublished(outputDirectory: string, result: ProductionEvidenceExportResult) {
  const composite = JSON.parse(fs.readFileSync(result.compositePath, 'utf8')) as CompositeManifest;
  const terminalManifests = result.terminalPaths.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  const journalRecords = composite.nodes.flatMap(node => fs.readFileSync(
    path.join(outputDirectory, node.journal_path), 'utf8',
  ).trimEnd().split('\n').map(line => JSON.parse(line)));
  return { outputDirectory, result, composite, terminalManifests, journalRecords };
}

function buildAttempts(
  repo: ProductionAttemptIdentityRepo, definition: ReturnType<typeof scenarioSpecs>,
  scope: { rootRunId: string; trialId: string }, options: ProductionBoundaryOptions,
): AttemptFixture[] {
  const attempts: AttemptFixture[] = [];
  for (const spec of definition.specs) {
    const events = definition.specs.length === 1
      ? options.events ?? (options.event ? [options.event] : undefined) : undefined;
    attempts.push(appendAttempt(
      repo, attempts.map(item => item.identity), scope.rootRunId, scope.trialId,
      options.backend ?? 'claude', options.accounting ?? 'complete', spec, events,
    ));
  }
  return attempts;
}

function evidenceSources(
  repo: ProductionAttemptIdentityRepo, attempts: readonly AttemptFixture[],
  tasks: readonly Task[],
): ProductionEvidenceSources {
  return {
    flush: async () => {}, listIdentities: scope => repo.list(scope),
    getJournal: id => attempts.find(item => item.identity.execution_id === id)?.journal ?? null,
    getExecution: id => attempts.find(item => item.execution.id === id)?.execution ?? null,
    getThread: id => attempts.find(item => item.thread.id === id)?.thread ?? null,
    readCosts: async () => attempts.map(item => item.cost),
    readTopology: project => readProductionTopologyFacts({ project }), readTasks: () => tasks,
  };
}

export function createProductionBoundaryFixture(
  options: ProductionBoundaryOptions = {},
): ProductionBoundaryFixture {
  const scenario = options.scenario ?? 'direct';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-boundary-'));
  const project = `boundary-${randomUUID()}`;
  const scope = { trialId: 'trial-production', rootRunId: `root-${randomUUID()}` };
  const outputDirectory = path.join(root, 'evidence');
  const repo = new ProductionAttemptIdentityRepo(path.join(root, 'identities.jsonl'));
  initializeProductionAttemptJournals({
    journalDir: path.join(root, 'journals'), storePath: path.join(root, 'journals.jsonl'),
  });
  const definition = scenarioSpecs(scenario, project);
  const attempts = buildAttempts(repo, definition, scope, options);
  const facts = scenario.startsWith('manager') ? managerFacts(
    project, scenario === 'manager-qa-on', scenario === 'manager-history',
  ) : [];
  const roles = [...new Set(attempts.map(item => item.identity.role))];
  const input = inputFor(
    outputDirectory, project, scope.trialId, scope.rootRunId, scenario, roles,
  );
  const sources = evidenceSources(repo, attempts, definition.tasks);
  return {
    root, project, input, sources, attempts, facts, tasks: definition.tasks,
    publish: async () => readPublished(outputDirectory,
      await exportProductionBenchmarkEvidence(input, sources)),
    cleanup: () => { resetProductionAttemptJournals(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

export async function withPublishedProductionBoundary(
  options: ProductionBoundaryOptions,
  verify: (published: PublishedProductionBoundary, fixture: ProductionBoundaryFixture) => void | Promise<void>,
): Promise<void> {
  const fixture = createProductionBoundaryFixture(options);
  try { await verify(await fixture.publish(), fixture); }
  finally { fixture.cleanup(); }
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeMirrorPayload(published: PublishedProductionBoundary): string {
  const payload = path.join(path.dirname(published.outputDirectory), 'python-mirror.json');
  const root = published.composite.nodes.find(
    node => node.attempt_id === published.composite.roots.root_attempt_id,
  )!;
  const terminal = JSON.parse(fs.readFileSync(
    path.join(published.outputDirectory, root.terminal_manifest_path), 'utf8',
  ));
  fs.writeFileSync(payload, JSON.stringify({ composite: published.composite, terminal }));
  return payload;
}

export function pythonHostMirrorAccepts(published: PublishedProductionBoundary): boolean {
  const script = [
    'import json,sys,pathlib,typing',
    'typing.override=getattr(typing,"override",lambda value:value)',
    'from cortex_bench_harness.inner_validation import valid_composite_structure',
    'from cortex_bench_harness.host_finalization import _parent_terminal_link,_validate_attempt_bytes',
    'x=json.load(open(sys.argv[1])); root=pathlib.Path(sys.argv[2])',
    'c=x["composite"]; t=x["terminal"]',
    'arm={"orchestration":{"mode":c["predicate"]["mode"]}}',
    'ok=valid_composite_structure(c,t,c["root_run_id"],c["trial_id"],arm)',
    'rn=next(n for n in c["nodes"] if n["attempt_id"]==c["roots"]["root_attempt_id"])',
    'ok=ok and _parent_terminal_link(c,t,(root/rn["terminal_manifest_path"]).read_bytes(),c["root_run_id"])',
    '[_validate_attempt_bytes(root,n,n["terminal_manifest_path"],n["journal_path"]) for n in c["nodes"]]',
    'print("true" if ok else "false")',
  ].join(';');
  const harness = path.resolve(process.cwd(), '../benchmark/harness');
  const output = execFileSync('uv', [
    'run', '--frozen', '--project', harness, 'python', '-c', script,
    writeMirrorPayload(published), published.outputDirectory,
  ], {
    env: { ...process.env, PYTHONPATH: path.join(harness, 'src') }, encoding: 'utf8',
  });
  return output.trim() === 'true';
}
