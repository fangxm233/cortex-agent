import { createHash } from 'node:crypto';

import { executionRepo, type ExecutionRecord } from '../../store/execution-repo.js';
import { costRepo, type CostEntry } from '../costs/cost-tracker.js';
import {
  buildAtifTree, type AtifNode, type AtifTrajectory,
} from './atif.js';
import {
  buildTerminalManifest, terminalManifestProblem, type TerminalReason, type TerminalState,
} from './manifest-contract.js';
import {
  listProductionAttemptIdentities, type ProductionAttemptIdentityRecord,
} from './production-attempt-identity.js';
import {
  getProductionAttemptJournal, type ProductionAttemptJournalRecord,
} from './production-attempt-journal.js';
import {
  buildAccountingRecord, journalCostFromNumber, type JournalTotals, type ProxyExport,
  type Tagged,
} from './accounting-reconciliation.js';
import {
  assignAttemptOrdinals, type AttemptEdge, type AttemptRecord,
} from './attempt-record.js';
import {
  buildCompositeManifest, canonicalCompositeManifestBytes, validateCompositeManifest,
  type CompositeManifest, type PredicateCheckResult,
} from './composite-manifest.js';
import { PRODUCTION_ROLE } from './journal.js';
import {
  parseProductionEvidenceJournal, type ParsedProductionJournal,
} from './production-evidence-journal.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PATH_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface ProductionEvidenceExportInput {
  outputDirectory: string;
  trialId: string;
  rootRunId: string;
  armName: string;
  armCanonicalSha256: string;
  bundleManifestHash: string;
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
  readCosts(): Promise<readonly CostEntry[]>;
}

export class ProductionEvidenceExportError extends Error {
  constructor(detail: string) {
    super(`production evidence export failed: ${detail}`);
    this.name = 'ProductionEvidenceExportError';
  }
}

export interface ProductionEvidenceProjection {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly terminalPaths: readonly string[];
}

interface AttemptSource {
  readonly identity: ProductionAttemptIdentityRecord;
  readonly journal: ProductionAttemptJournalRecord;
  readonly execution: ExecutionRecord;
  readonly parsedJournal: ParsedProductionJournal;
  readonly costs: readonly CostEntry[];
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

function requireTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (Number.isNaN(Date.parse(text)) || new Date(text).toISOString() !== text) {
    fail(`${label} is invalid`);
  }
  return text;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

function assertEvaluatedChecks(value: unknown): void {
  if (value === undefined) return;
  const checks = requireRecord(value, 'evaluated checks');
  for (const [name, candidate] of Object.entries(checks)) {
    const check = requireRecord(candidate, `evaluated check ${name}`);
    if (!isOneOf(check.result, ['pass', 'fail', 'unavailable'])) {
      fail(`evaluated check ${name} result is invalid`);
    }
    if (check.detail !== null && typeof check.detail !== 'string') {
      fail(`evaluated check ${name} detail is invalid`);
    }
    if (check.result === 'fail') fail('failed predicate cannot be published');
  }
}

export function assertProductionEvidenceExportInput(
  value: unknown,
): asserts value is ProductionEvidenceExportInput {
  const input = requireRecord(value, 'input');
  requiredText(input.outputDirectory, 'output directory');
  requiredText(input.trialId, 'trial identity');
  requiredText(input.rootRunId, 'root run identity');
  requiredText(input.armName, 'arm name');
  requireHash(input.armCanonicalSha256, 'arm canonical hash');
  requireHash(input.bundleManifestHash, 'bundle manifest hash');
  const proxy = requireRecord(input.proxyExport, 'proxy export');
  if (proxy.trial_id !== input.trialId) fail('proxy trial identity mismatch');
  assertEvaluatedChecks(input.evaluatedChecks);
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
  if (execution.session.sessionId !== identity.session_id) {
    fail(`execution linkage mismatch for ${identity.attempt_id}`);
  }
  if (!['completed', 'failed', 'cancelled'].includes(execution.status)) {
    fail(`execution is not classifiable for ${identity.attempt_id}`);
  }
}

function correlationMatches(cost: CostEntry, identity: ProductionAttemptIdentityRecord): boolean {
  const fields: Array<[unknown, unknown]> = [
    [cost.execution_id, identity.execution_id], [cost.session_id, identity.session_id],
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
    return {
      identity, journal, execution,
      parsedJournal: parseProductionEvidenceJournal(journal, identity),
      costs: costRows.get(identity.attempt_id) ?? [],
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

function terminalOutcome(source: AttemptSource): { state: TerminalState; reason: TerminalReason } {
  const outcomes: Record<string, { state: TerminalState; reason: TerminalReason }> = {
    completed: { state: 'completed', reason: 'ok' },
    cancelled: { state: 'cancelled', reason: 'cancelled' },
    failed: source.parsedJournal.rateLimited
      ? { state: 'failed', reason: 'rate_limited' }
      : { state: 'failed', reason: 'child_failure' },
  };
  return outcomes[source.execution.status] ?? fail(`terminal outcome missing for ${source.identity.attempt_id}`);
}

/** A session's attempts form one chain: each later attempt continued the one before it. */
function spawnEdges(attempts: readonly AttemptSource[]): AttemptEdge[] {
  return attempts.flatMap((item): AttemptEdge[] => item.identity.spawn_parent_attempt_id ? [{
    kind: 'spawn',
    from: { ref: 'attempt', id: item.identity.spawn_parent_attempt_id },
    to: { ref: 'attempt', id: item.identity.attempt_id },
  }] : []);
}

function terminalBytes(
  source: AttemptSource, state: TerminalState, reason: TerminalReason,
  attemptUsage: AttemptUsage, journalPath: string,
): Buffer {
  const terminal = buildTerminalManifest({
    trajectoryRoot: '/', state, startedAt: source.execution.runtime.startedAt,
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
  attempts: readonly AttemptSource[], rootAttemptId: string,
): ProjectedAttempt[] {
  return attempts.map(source => {
    const outcome = terminalOutcome(source);
    const attemptUsage = usage(source);
    const isRoot = source.identity.attempt_id === rootAttemptId;
    const journalPath = isRoot ? 'events.jsonl'
      : `journals/${source.identity.attempt_id}.ndjson`;
    const terminalPath = isRoot ? `run-${source.identity.root_run_id}.terminal.json`
      : `${source.identity.attempt_id}.terminal.json`;
    const bytes = terminalBytes(source, outcome.state, outcome.reason, attemptUsage, journalPath);
    return {
      source, state: outcome.state, reason: outcome.reason,
      usage: attemptUsage, journalPath, terminalPath,
      terminalBytes: bytes, terminalSha256: sha256(bytes),
    };
  });
}

function attemptRecords(projected: readonly ProjectedAttempt[]): AttemptRecord[] {
  const ordinals = assignAttemptOrdinals(projected.map(item => ({
    attempt_id: item.source.identity.attempt_id, task_id: item.source.identity.trial_id,
    started_at: item.source.execution.runtime.startedAt,
  })));
  return projected.map(item => {
    const { identity, execution, parsedJournal, journal } = item.source;
    return {
      trial_id: identity.trial_id, root_run_id: identity.root_run_id,
      task_id: identity.trial_id, parent_task_id: null,
      dispatch_generation: null, attempt_id: identity.attempt_id,
      attempt_ordinal: ordinals.get(identity.attempt_id)!,
      session_id: identity.session_id, execution_id: identity.execution_id,
      task_ancestry: [identity.trial_id], role: PRODUCTION_ROLE, backend: identity.backend,
      provider: identity.provider, requested_model: identity.requested_model,
      reported_model: parsedJournal.reportedModel,
      model_execution_identity_hash: identity.model_execution_identity_hash,
      role_tool_surface_hash: identity.role_tool_surface_hash,
      bundle_manifest_hash: identity.bundle_manifest_hash,
      terminal_state: item.state, terminal_reason: item.reason,
      disposition: 'none', superseded_by: null,
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
  const values = new Set(attempts.map(attempt => read(attempt.identity)));
  if (values.size !== 1) fail(`role identity drift for ${PRODUCTION_ROLE}`);
  return { [PRODUCTION_ROLE]: [...values][0] };
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
    source: 'trajectory_merge', roles: [PRODUCTION_ROLE],
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
    session_id: item.source.identity.session_id,
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
    children: children.map(child => atifNode(child, attempts)),
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
  const trajectory = buildAtifTree(atifNode(root[0], projected));
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
  assertProductionEvidenceExportInput(input);
  await sources.flush();
  const identities = sources.listIdentities({ trialId: input.trialId, rootRunId: input.rootRunId });
  const attempts = collectSources(input, sources, identities, await sources.readCosts());
  const root = rootAttempt(attempts);
  const projected = projectAttempts(attempts, root.identity.attempt_id);
  const manifest = buildCompositeManifest({
    trial_id: input.trialId, root_run_id: input.rootRunId,
    arm_name: input.armName, arm_canonical_sha256: input.armCanonicalSha256,
    identity: {
      model_execution_identity_hash: identityMap(attempts, value => value.model_execution_identity_hash),
      role_tool_surface_hash: identityMap(attempts, value => value.role_tool_surface_hash),
      bundle_manifest_hash: input.bundleManifestHash,
    },
    nodes: attemptRecords(projected), edges: spawnEdges(attempts),
    roots: { root_attempt_id: root.identity.attempt_id, root_task_id: null },
    accounting: buildAccountingRecord(input.proxyExport, journalTotals(projected)),
    mode: 'direct', evaluatedChecks: input.evaluatedChecks,
  });
  const violations = validateCompositeManifest(manifest, {
    lifecycleStems: projected.map(item => item.source.identity.attempt_id),
  });
  if (violations.length > 0) fail(`composite invalid: ${violations.map(item => item.code).join(',')}`);
  return {
    files: projectionFiles(projected, manifest),
    terminalPaths: projected.map(item => item.terminalPath),
  };
}

export const PRODUCTION_EVIDENCE_SOURCES: ProductionEvidenceSources = {
  flush: async () => {
    await Promise.all([executionRepo.flush(), costRepo.flush()]);
  },
  listIdentities: listProductionAttemptIdentities,
  getJournal: getProductionAttemptJournal,
  getExecution: executionId => executionRepo.getExecution(executionId),
  readCosts: async () => (await costRepo.readCosts()).entries,
};
