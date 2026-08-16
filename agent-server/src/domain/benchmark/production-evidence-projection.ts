// input:  launcher facts, durable attempts, attributed usage
// output: validated token-complete terminal/composite v2 bytes
// pos:    Production evidence read-model projection
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';

import type { ThreadRecord } from '../../core/types/thread-types.js';
import { scanAllTasks, type Task } from '../../core/task-parser.js';
import { executionRepo, type ExecutionRecord } from '../../store/execution-repo.js';
import { threadStore } from '../../store/thread-repo.js';
import { costRepo, type CostEntry } from '../costs/cost-tracker.js';
import {
  buildAtifTree, type AtifNode, type AtifTrajectory,
} from '../agent-run/atif.js';
import {
  buildTerminalManifest, terminalManifestProblem, type TerminalReason, type TerminalState,
} from '../agent-run/manifest-contract.js';
import {
  listProductionAttemptIdentities, type ProductionAttemptIdentityRecord,
} from '../agent-run/production-attempt-identity.js';
import {
  getProductionAttemptJournal, type ProductionAttemptJournalRecord,
} from '../agent-run/production-attempt-journal.js';
import {
  buildAccountingRecord, journalCostFromNumber, type JournalTotals, type ProxyExport,
  type Tagged,
} from './accounting-reconciliation.js';
import {
  assignAttemptOrdinals, type AttemptDisposition, type AttemptRecord,
} from './attempt-record.js';
import {
  buildCompositeManifest, canonicalCompositeManifestBytes, validateCompositeManifest,
  type CompositeManifest, type OrchestrationModeName, type PredicateCheckResult,
} from './composite-manifest.js';
import {
  readProductionTopologyFacts, type ProductionTopologyFact,
} from '../tasks/production-topology-ledger.js';
import {
  parseProductionEvidenceJournal, type ParsedProductionJournal,
} from './production-evidence-journal.js';
import { projectProductionEvidenceTopology } from './production-evidence-topology.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PATH_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface ProductionEvidenceExportInput {
  outputDirectory: string;
  project: string;
  trialId: string;
  rootRunId: string;
  armName: string;
  armCanonicalSha256: string;
  bundleManifestHash: string;
  mode: OrchestrationModeName;
  expectedRoles: readonly string[];
  managerQa: 'on' | 'off' | null;
  limits: { max_task_depth: number; max_tasks: number };
  proxyExport: ProxyExport;
  evaluatedChecks?: Readonly<Record<
    string, { result: PredicateCheckResult; detail: string | null }
  >>;
}

export interface ProductionEvidenceSources {
  flush(): Promise<void>;
  listIdentities(scope: {
    trialId: string; rootRunId: string;
  }): readonly ProductionAttemptIdentityRecord[];
  getJournal(executionId: string): ProductionAttemptJournalRecord | null;
  getExecution(executionId: string): ExecutionRecord | null;
  getThread(threadId: string): ThreadRecord | null;
  readCosts(): Promise<readonly CostEntry[]>;
  readTopology(project: string): readonly ProductionTopologyFact[];
  readTasks(project: string): readonly Task[];
}

export class ProductionEvidenceExportError extends Error {
  constructor(detail: string) {
    super(`production evidence export failed: ${detail}`);
    this.name = 'ProductionEvidenceExportError';
  }
}

export interface ProductionEvidenceProjection {
  readonly manifest: CompositeManifest;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly terminalPaths: readonly string[];
}

interface AttemptSource {
  readonly identity: ProductionAttemptIdentityRecord;
  readonly journal: ProductionAttemptJournalRecord;
  readonly execution: ExecutionRecord;
  readonly thread: ThreadRecord;
  readonly parsedJournal: ParsedProductionJournal;
  readonly costs: readonly CostEntry[];
  readonly taskAncestry: readonly string[];
  readonly parentTaskId: string | null;
  readonly taskDependencies: readonly string[];
}

interface AttemptUsage {
  readonly steps: number | null;
  readonly costUsd: number | null;
  readonly tokens: AttemptRecord['tokens'];
  readonly providerRequests: number | null;
}

interface ProjectedAttempt {
  readonly source: AttemptSource;
  readonly state: TerminalState;
  readonly reason: TerminalReason;
  readonly disposition: AttemptDisposition;
  readonly usage: AttemptUsage;
  readonly journalPath: string;
  readonly terminalPath: string;
  readonly terminalBytes: Buffer;
  readonly terminalSha256: string;
}

function fail(detail: string): never {
  throw new ProductionEvidenceExportError(detail);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is missing`);
  return value;
}

function requireHash(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!SHA256_PATTERN.test(text)) fail(`${label} is not sha256`);
  return text;
}

function requireCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} is invalid`);
  return Number(value);
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (Number.isNaN(Date.parse(text)) || new Date(text).toISOString() !== text) {
    fail(`${label} is invalid`);
  }
  return text;
}

function assertInput(input: ProductionEvidenceExportInput): void {
  requiredText(input.project, 'project');
  requiredText(input.trialId, 'trial identity');
  requiredText(input.rootRunId, 'root run identity');
  requiredText(input.armName, 'arm name');
  requireHash(input.armCanonicalSha256, 'arm canonical hash');
  requireHash(input.bundleManifestHash, 'bundle manifest hash');
  requireCount(input.limits.max_task_depth, 'max task depth');
  requireCount(input.limits.max_tasks, 'max tasks');
  if (!Array.isArray(input.expectedRoles) || input.expectedRoles.length === 0
    || input.expectedRoles.some(role => typeof role !== 'string' || role.length === 0)
    || new Set(input.expectedRoles).size !== input.expectedRoles.length) {
    fail('expected role set is invalid');
  }
  if ((input.mode === 'manager') !== (input.managerQa !== null)) {
    fail('manager Q&A mode is invalid');
  }
  if (input.proxyExport.trial_id !== input.trialId) fail('proxy trial identity mismatch');
  for (const check of Object.values(input.evaluatedChecks ?? {})) {
    if (check.result === 'fail') fail('failed predicate cannot be published');
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertIdentity(
  identity: ProductionAttemptIdentityRecord, input: ProductionEvidenceExportInput,
): void {
  if (identity.trial_id !== input.trialId || identity.root_run_id !== input.rootRunId) {
    fail(`attempt scope mismatch for ${identity.attempt_id}`);
  }
  if (identity.bundle_manifest_hash !== input.bundleManifestHash) {
    fail(`bundle identity mismatch for ${identity.attempt_id}`);
  }
  requireHash(identity.model_execution_identity_hash, 'model execution identity');
  requireHash(identity.role_tool_surface_hash, 'role tool identity');
  if (!PATH_ID_PATTERN.test(identity.attempt_id)) fail(`attempt path identity invalid: ${identity.attempt_id}`);
}

function assertExecution(
  execution: ExecutionRecord, identity: ProductionAttemptIdentityRecord,
): void {
  const started = requireTimestamp(execution.runtime.startedAt, 'execution started_at');
  const ended = requireTimestamp(execution.runtime.endedAt, 'execution ended_at');
  const frozen = requireTimestamp(identity.frozen_at, 'identity frozen_at');
  if (started > frozen || frozen > ended) fail(`attempt timing mismatch for ${identity.attempt_id}`);
  if (execution.thread?.threadId !== identity.thread_id
    || execution.thread.agentSlotId !== identity.role) {
    fail(`execution linkage mismatch for ${identity.attempt_id}`);
  }
  if (!['completed', 'failed', 'cancelled'].includes(execution.status)) {
    fail(`execution is not classifiable for ${identity.attempt_id}`);
  }
}

function taskAncestry(taskId: string, tasks: ReadonlyMap<string, Task>): string[] {
  const ancestry: string[] = [];
  const seen = new Set<string>();
  let current: string | null = taskId;
  while (current) {
    if (seen.has(current)) fail(`task ancestry cycle at ${current}`);
    seen.add(current);
    const task = tasks.get(current);
    if (!task) fail(`task record missing for ${current}`);
    ancestry.push(current);
    current = task.parent;
  }
  return ancestry.reverse();
}

function taskProjection(
  identity: ProductionAttemptIdentityRecord, input: ProductionEvidenceExportInput,
  tasks: ReadonlyMap<string, Task>,
): { ancestry: readonly string[]; parent: string | null; dependencies: readonly string[] } {
  if (input.mode !== 'manager') {
    if (identity.task_id !== input.trialId || identity.task_project !== null
      || identity.dispatch_generation !== null) fail(`taskless identity invalid for ${identity.attempt_id}`);
    return { ancestry: [input.trialId], parent: null, dependencies: [] };
  }
  if (identity.task_project !== input.project) fail(`task project mismatch for ${identity.attempt_id}`);
  const task = tasks.get(identity.task_id);
  if (!task) fail(`task record missing for ${identity.attempt_id}`);
  return {
    ancestry: taskAncestry(identity.task_id, tasks), parent: task.parent,
    dependencies: [...task.depends_on],
  };
}

function correlationMatches(cost: CostEntry, identity: ProductionAttemptIdentityRecord): boolean {
  const fields: Array<[unknown, unknown]> = [
    [cost.execution_id, identity.execution_id], [cost.thread_id, identity.thread_id],
    [cost.parent_thread_id ?? null, identity.parent_thread_id],
    [cost.root_thread_id, identity.root_thread_id], [cost.task_id, identity.task_id],
    [cost.task_project ?? null, identity.task_project],
    [cost.dispatch_generation ?? null, identity.dispatch_generation],
    [cost.root_attempt_id, identity.root_attempt_id],
  ];
  return fields.every(([actual, expected]) => actual === expected);
}

function costRowsByAttempt(
  costs: readonly CostEntry[], identities: readonly ProductionAttemptIdentityRecord[],
  input: ProductionEvidenceExportInput,
): ReadonlyMap<string, readonly CostEntry[]> {
  const identityByAttempt = new Map(identities.map(identity => [identity.attempt_id, identity]));
  const buckets = new Map<string, CostEntry[]>();
  for (const cost of costs.filter(entry => entry.trial_id === input.trialId)) {
    if (cost.root_run_id !== input.rootRunId) fail('cost root run identity mismatch');
    const attemptId = requiredText(cost.attempt_id, 'cost attempt identity');
    const identity = identityByAttempt.get(attemptId);
    if (!identity || !correlationMatches(cost, identity)) fail(`cost attribution mismatch for ${attemptId}`);
    const bucket = buckets.get(attemptId) ?? [];
    bucket.push(cost);
    buckets.set(attemptId, bucket);
  }
  return buckets;
}

function collectSources(
  input: ProductionEvidenceExportInput, source: ProductionEvidenceSources,
  identities: readonly ProductionAttemptIdentityRecord[], costs: readonly CostEntry[],
): AttemptSource[] {
  const tasks = new Map(source.readTasks(input.project).map(task => [task.id, task]));
  const costRows = costRowsByAttempt(costs, identities, input);
  return identities.map(identity => {
    assertIdentity(identity, input);
    const journal = source.getJournal(identity.execution_id);
    if (!journal || journal.attempt_id !== identity.attempt_id
      || journal.execution_id !== identity.execution_id) {
      fail(`journal record missing for ${identity.attempt_id}`);
    }
    const execution = source.getExecution(identity.execution_id);
    if (!execution) fail(`execution record missing for ${identity.attempt_id}`);
    assertExecution(execution, identity);
    const thread = source.getThread(identity.thread_id);
    if (!thread || thread.id !== identity.thread_id) {
      fail(`thread record missing for ${identity.attempt_id}`);
    }
    const task = taskProjection(identity, input, tasks);
    return {
      identity, journal, execution, thread,
      parsedJournal: parseProductionEvidenceJournal(journal, identity),
      costs: costRows.get(identity.attempt_id) ?? [],
      taskAncestry: task.ancestry, parentTaskId: task.parent,
      taskDependencies: task.dependencies,
    };
  });
}

function sumNullable(
  rows: readonly CostEntry[], read: (row: CostEntry) => number | null | undefined,
): number | null {
  if (rows.length === 0) return null;
  const values = rows.map(read);
  if (values.some(value => value === null || value === undefined)) return null;
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    fail('cost row contains an invalid counter');
  }
  return (values as number[]).reduce((total, value) => total + value, 0);
}

function usage(source: AttemptSource): AttemptUsage {
  const requests = sumNullable(source.costs, row => row.provider_requests);
  if (requests === 0) fail(`provider request zero stand-in for ${source.identity.attempt_id}`);
  return {
    steps: sumNullable(source.costs, row => row.num_turns) ?? source.execution.metrics.numTurns,
    costUsd: sumNullable(source.costs, row => row.cost_usd) ?? source.execution.metrics.costUsd,
    tokens: {
      input: sumNullable(source.costs, row => row.input_tokens),
      output: sumNullable(source.costs, row => row.output_tokens),
      cache_read: sumNullable(source.costs, row => row.cache_read_tokens),
      cache_creation: sumNullable(source.costs, row => row.cache_creation_tokens),
    },
    providerRequests: requests,
  };
}

function finalAttemptForThread(
  candidate: AttemptSource, attempts: readonly AttemptSource[],
): boolean {
  const peers = attempts.filter(item => item.identity.thread_id === candidate.identity.thread_id);
  const finals = peers.filter(item => !peers.some(other => (
    other.identity.spawn_parent_attempt_id === item.identity.attempt_id
  )));
  if (finals.length !== 1) fail(`thread ${candidate.identity.thread_id} final attempt is ambiguous`);
  return finals[0].identity.attempt_id === candidate.identity.attempt_id;
}

function terminalOutcome(
  source: AttemptSource, attempts: readonly AttemptSource[],
): { state: TerminalState; reason: TerminalReason } {
  if (source.thread.status === 'aborted' && finalAttemptForThread(source, attempts)) {
    return { state: 'aborted', reason: 'aborted' };
  }
  const outcomes: Record<string, { state: TerminalState; reason: TerminalReason }> = {
    completed: { state: 'completed', reason: 'ok' },
    cancelled: { state: 'cancelled', reason: 'cancelled' },
    failed: source.parsedJournal.rateLimited
      ? { state: 'failed', reason: 'rate_limited' }
      : { state: 'failed', reason: 'child_failure' },
  };
  return outcomes[source.execution.status] ?? fail(`terminal outcome missing for ${source.identity.attempt_id}`);
}

function assertExpectedRoles(
  input: ProductionEvidenceExportInput, attempts: readonly AttemptSource[],
): void {
  const expected = [...input.expectedRoles].sort();
  const observed = [...new Set(attempts.map(item => item.identity.role))].sort();
  if (input.mode === 'direct' && attempts.length !== 1) {
    fail(`direct host mirror requires one attempt, got ${attempts.length}`);
  }
  if (expected.join('\0') !== observed.join('\0')) {
    fail(`attempt roles mismatch: expected ${expected.join(',')}, got ${observed.join(',')}`);
  }
}

function terminalBytes(
  source: AttemptSource, state: TerminalState, reason: TerminalReason,
  attemptUsage: AttemptUsage, journalPath: string,
): Buffer {
  const terminal = buildTerminalManifest({
    trajectoryRoot: '/', canonicalTrajectoryRoot: true,
    rootRunId: source.identity.root_run_id, threadId: source.identity.thread_id,
    state, startedAt: source.execution.runtime.startedAt,
    endedAt: source.execution.runtime.endedAt!, journalPath,
    journalSha256: source.journal.journal_sha256, eventCount: source.journal.event_count,
    steps: attemptUsage.steps, costUsd: attemptUsage.costUsd,
    tokens: {
      input: attemptUsage.tokens.input, output: attemptUsage.tokens.output,
      cache_read: attemptUsage.tokens.cache_read,
      cache_creation: attemptUsage.tokens.cache_creation,
    },
    modelExecutionIdentityHash: source.identity.model_execution_identity_hash,
    roleToolSurfaceHash: source.identity.role_tool_surface_hash,
    bundleManifestHash: source.identity.bundle_manifest_hash, terminalReason: reason,
  });
  const problem = terminalManifestProblem(terminal);
  if (problem) fail(`terminal manifest ${problem} for ${source.identity.attempt_id}`);
  return Buffer.from(`${JSON.stringify(terminal)}\n`, 'utf8');
}

function projectAttempts(
  attempts: readonly AttemptSource[], dispositions: ReadonlyMap<string, AttemptDisposition>,
  rootAttemptId: string,
): ProjectedAttempt[] {
  return attempts.map(source => {
    const outcome = terminalOutcome(source, attempts);
    const attemptUsage = usage(source);
    const isRoot = source.identity.attempt_id === rootAttemptId;
    const journalPath = isRoot ? 'events.jsonl'
      : `journals/${source.identity.attempt_id}.ndjson`;
    const terminalPath = isRoot ? `run-${source.identity.root_run_id}.terminal.json`
      : `${source.identity.attempt_id}.terminal.json`;
    const bytes = terminalBytes(source, outcome.state, outcome.reason, attemptUsage, journalPath);
    return {
      source, state: outcome.state, reason: outcome.reason,
      disposition: dispositions.get(source.identity.attempt_id) ?? 'none',
      usage: attemptUsage, journalPath, terminalPath,
      terminalBytes: bytes, terminalSha256: sha256(bytes),
    };
  });
}

function attemptRecords(projected: readonly ProjectedAttempt[]): AttemptRecord[] {
  const ordinals = assignAttemptOrdinals(projected.map(item => ({
    attempt_id: item.source.identity.attempt_id, task_id: item.source.identity.task_id,
    started_at: item.source.execution.runtime.startedAt,
  })));
  return projected.map(item => {
    const { identity, execution, parsedJournal, journal } = item.source;
    return {
      trial_id: identity.trial_id, root_run_id: identity.root_run_id,
      task_id: identity.task_id, parent_task_id: item.source.parentTaskId,
      dispatch_generation: identity.dispatch_generation, attempt_id: identity.attempt_id,
      attempt_ordinal: ordinals.get(identity.attempt_id)!, thread_id: identity.thread_id,
      parent_thread_id: identity.parent_thread_id, root_thread_id: identity.root_thread_id,
      task_ancestry: item.source.taskAncestry, template: identity.template,
      role: identity.role, stage: identity.stage, backend: identity.backend,
      provider: identity.provider, requested_model: identity.requested_model,
      reported_model: parsedJournal.reportedModel,
      model_execution_identity_hash: identity.model_execution_identity_hash,
      role_tool_surface_hash: identity.role_tool_surface_hash,
      bundle_manifest_hash: identity.bundle_manifest_hash,
      terminal_state: item.state, terminal_reason: item.reason,
      disposition: item.disposition, superseded_by: null,
      artifact_path: null, artifact_sha256: null, journal_path: item.journalPath,
      journal_sha256: journal.journal_sha256, event_count: journal.event_count,
      terminal_manifest_path: item.terminalPath,
      terminal_manifest_sha256: item.terminalSha256, edges: [],
      started_at: execution.runtime.startedAt, ended_at: execution.runtime.endedAt!,
      steps: item.usage.steps, cost_usd: item.usage.costUsd,
      tokens: item.usage.tokens, provider_requests: item.usage.providerRequests,
    };
  });
}

function identityMap(
  attempts: readonly AttemptSource[], read: (identity: ProductionAttemptIdentityRecord) => string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const attempt of attempts) {
    const value = read(attempt.identity);
    const existing = result[attempt.identity.role];
    if (existing && existing !== value) fail(`role identity drift for ${attempt.identity.role}`);
    result[attempt.identity.role] = value;
  }
  return result;
}

function availableTotal(values: readonly (number | null)[]): Tagged<number> {
  if (values.some(value => value === null)) {
    return { status: 'unavailable', reason: 'journal_underivable' };
  }
  return { status: 'available', value: (values as number[]).reduce((sum, value) => sum + value, 0) };
}

function journalTotals(projected: readonly ProjectedAttempt[]): JournalTotals {
  const costs = projected.map(item => item.usage.costUsd);
  const cost = costs.some(value => value === null)
    ? { status: 'unavailable', reason: 'journal_underivable' } as const
    : journalCostFromNumber((costs as number[]).reduce((sum, value) => sum + value, 0));
  return {
    requests: availableTotal(projected.map(item => item.usage.providerRequests)),
    cost_usd: cost,
    steps: availableTotal(projected.map(item => item.usage.steps)),
    tokens: {
      input: availableTotal(projected.map(item => item.usage.tokens.input)),
      output: availableTotal(projected.map(item => item.usage.tokens.output)),
      cached: availableTotal(projected.map(item => item.usage.tokens.cache_read)),
    },
    source: 'trajectory_merge', roles: [...new Set(projected.map(item => item.source.identity.role))],
  };
}

function rootAttempt(attempts: readonly AttemptSource[]): AttemptSource {
  const roots = attempts.filter(item => item.identity.spawn_parent_attempt_id === null
    && item.identity.attempt_id === item.identity.root_attempt_id);
  if (roots.length !== 1) fail(`real production root resolves to ${roots.length} attempts`);
  return roots[0];
}

function startedBytes(item: ProjectedAttempt): Buffer {
  return Buffer.from(`${JSON.stringify({
    root_run_id: item.source.identity.root_run_id,
    thread_id: item.source.identity.thread_id,
    ts: item.source.execution.runtime.startedAt,
    journal_path: item.journalPath,
  })}\n`, 'utf8');
}

function terminalDocument(item: ProjectedAttempt): Record<string, unknown> {
  const parsed = JSON.parse(item.terminalBytes.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(`terminal bytes malformed for ${item.source.identity.attempt_id}`);
  }
  return parsed as Record<string, unknown>;
}

function atifNode(item: ProjectedAttempt, attempts: readonly ProjectedAttempt[]): AtifNode {
  const children = attempts.filter(candidate => (
    candidate.source.identity.spawn_parent_attempt_id === item.source.identity.attempt_id
  ));
  return {
    fragment: {
      header: item.source.parsedJournal.header,
      events: [...item.source.parsedJournal.events],
      terminal: terminalDocument(item),
    },
    links: [], children: children.map(child => atifNode(child, attempts)),
  };
}

function bindAtifAttemptIds(
  trajectory: AtifTrajectory, item: ProjectedAttempt,
  attempts: readonly ProjectedAttempt[],
): void {
  trajectory.trajectory_id = item.source.identity.attempt_id;
  trajectory.extra.attempt_id = item.source.identity.attempt_id;
  const children = attempts.filter(candidate => (
    candidate.source.identity.spawn_parent_attempt_id === item.source.identity.attempt_id
  ));
  const childTrajectories = trajectory.subagent_trajectories ?? [];
  if (children.length !== childTrajectories.length) fail('ATIF child projection mismatch');
  children.forEach((child, index) => bindAtifAttemptIds(
    childTrajectories[index], child, attempts,
  ));
}

function trajectoryBytes(projected: readonly ProjectedAttempt[]): Buffer {
  const root = projected.filter(item => (
    item.source.identity.spawn_parent_attempt_id === null
    && item.source.identity.root_attempt_id === item.source.identity.attempt_id
  ));
  if (root.length !== 1) fail(`ATIF root resolves to ${root.length} attempts`);
  const trajectory = buildAtifTree(atifNode(root[0], projected), 'explicit', null);
  bindAtifAttemptIds(trajectory, root[0], projected);
  return Buffer.from(`${JSON.stringify(trajectory, null, 2)}\n`, 'utf8');
}

function projectionFiles(
  projected: readonly ProjectedAttempt[], manifest: CompositeManifest,
): ReadonlyMap<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const item of projected) {
    files.set(item.journalPath, item.source.parsedJournal.bytes);
    files.set(item.terminalPath.replace('.terminal.json', '.started.json'), startedBytes(item));
    files.set(item.terminalPath, item.terminalBytes);
  }
  files.set('composite-manifest.json', canonicalCompositeManifestBytes(manifest));
  files.set('trajectory.json', trajectoryBytes(projected));
  return files;
}

export async function projectProductionBenchmarkEvidence(
  input: ProductionEvidenceExportInput, sources: ProductionEvidenceSources,
): Promise<ProductionEvidenceProjection> {
  assertInput(input);
  await sources.flush();
  const identities = sources.listIdentities({ trialId: input.trialId, rootRunId: input.rootRunId });
  const attempts = collectSources(input, sources, identities, await sources.readCosts());
  const facts = sources.readTopology(input.project);
  assertExpectedRoles(input, attempts);
  const topology = projectProductionEvidenceTopology(
    input.mode, input.managerQa, facts, attempts,
  );
  const root = rootAttempt(attempts);
  const projected = projectAttempts(
    attempts, topology.dispositions, root.identity.attempt_id,
  );
  const manifest = buildCompositeManifest({
    trial_id: input.trialId, root_run_id: input.rootRunId,
    arm_name: input.armName, arm_canonical_sha256: input.armCanonicalSha256,
    identity: {
      model_execution_identity_hash: identityMap(attempts, value => value.model_execution_identity_hash),
      role_tool_surface_hash: identityMap(attempts, value => value.role_tool_surface_hash),
      bundle_manifest_hash: input.bundleManifestHash,
    },
    nodes: attemptRecords(projected), edges: topology.edges,
    roots: {
      root_attempt_id: root.identity.attempt_id,
      root_task_id: input.mode === 'manager' ? root.identity.task_id : null,
    },
    accounting: buildAccountingRecord(input.proxyExport, journalTotals(projected)),
    mode: input.mode, evaluatedChecks: input.evaluatedChecks,
  });
  const violations = validateCompositeManifest(manifest, {
    limits: input.limits, lifecycleStems: projected.map(item => item.source.identity.attempt_id),
  });
  if (violations.length > 0) fail(`composite invalid: ${violations.map(item => item.code).join(',')}`);
  return {
    manifest, files: projectionFiles(projected, manifest),
    terminalPaths: projected.map(item => item.terminalPath),
  };
}

export const PRODUCTION_EVIDENCE_SOURCES: ProductionEvidenceSources = {
  flush: async () => {
    await Promise.all([executionRepo.flush(), threadStore.flush(), costRepo.flush()]);
  },
  listIdentities: listProductionAttemptIdentities,
  getJournal: getProductionAttemptJournal,
  getExecution: executionId => executionRepo.getExecution(executionId),
  getThread: threadId => threadStore.get(threadId),
  readCosts: async () => (await costRepo.readCosts()).entries,
  readTopology: project => readProductionTopologyFacts({ project }),
  readTasks: project => scanAllTasks(project),
};
