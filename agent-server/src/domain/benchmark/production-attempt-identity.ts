import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from '../../core/paths.js';
import type { Backend, EngineSpec } from '../../agent-adapter/types.js';
import type { ProductionBenchmarkEvidenceContext } from '../../core/types/benchmark-types.js';
import { parseProductionBenchmarkEvidenceContext } from '../../core/production-benchmark-evidence.js';
import type { RunRequest } from '../runs/request.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import {
  computeModelExecutionIdentityHash, computeRoleToolSurfaceHash,
} from './identity.js';
import { roleSurfaceFromSpec } from './role-surface.js';
import {
  initializeProductionAttemptJournals, resetProductionAttemptJournals,
} from './production-attempt-journal.js';

const RECORD_SCHEMA = 'cortex-production-attempt-identity/4';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_STORE_PATH = path.join(STORE_DIR, 'benchmark-attempt-identities.jsonl');
const RECORD_KEYS = [
  'schema_version', 'trial_id', 'root_run_id', 'attempt_id', 'root_attempt_id',
  'spawn_parent_attempt_id', 'execution_id', 'session_id', 'profile_name',
  'backend', 'provider', 'requested_model', 'model_execution_identity_hash',
  'role_tool_surface_hash', 'bundle_manifest_hash', 'frozen_at',
] as const;

export type ProductionAttemptIdentityRecord = Readonly<{
  schema_version: typeof RECORD_SCHEMA;
  trial_id: string;
  root_run_id: string;
  attempt_id: string;
  root_attempt_id: string;
  spawn_parent_attempt_id: string | null;
  execution_id: string;
  session_id: string;
  profile_name: string;
  backend: Backend;
  provider: string | null;
  requested_model: string;
  model_execution_identity_hash: string;
  role_tool_surface_hash: string;
  bundle_manifest_hash: string;
  frozen_at: string;
}>;

interface ConfigurationRevision {
  profiles: number;
  environments: number;
}

export interface ProductionAttemptIdentityInit {
  storePath?: string;
  configurationRevision?: () => ConfigurationRevision;
}

interface ActiveIdentityState {
  repo: ProductionAttemptIdentityRepo;
  revision: ConfigurationRevision | null;
  configurationRevision?: () => ConfigurationRevision;
}

interface FreezeAttemptInput {
  adapterBackend: Backend;
  spec: EngineSpec;
  request: RunRequest;
  /** The execution record this attempt belongs to — the attested attempt id is derived from it. */
  executionId: string | null;
  resolvedProfile: ResolvedProfileConfig | undefined;
}

let activeState: ActiveIdentityState | null = null;

function identityInputError(detail: string): Error {
  return new Error(`Production benchmark evidence context invalid: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => expected.has(key));
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw identityInputError(label);
  return value;
}

function isNullableString(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function storedRecordValid(value: Record<string, unknown>): boolean {
  const strings = [
    'trial_id', 'root_run_id', 'attempt_id', 'root_attempt_id', 'execution_id',
    'session_id', 'profile_name', 'requested_model', 'model_execution_identity_hash',
    'role_tool_surface_hash', 'bundle_manifest_hash', 'frozen_at',
  ];
  const nullable = ['spawn_parent_attempt_id', 'provider'];
  const hashes = [
    value.model_execution_identity_hash, value.role_tool_surface_hash, value.bundle_manifest_hash,
  ];
  return exactKeys(value, RECORD_KEYS)
    && value.schema_version === RECORD_SCHEMA
    && strings.every(key => typeof value[key] === 'string' && String(value[key]).length > 0)
    && nullable.every(key => isNullableString(value[key]))
    && (value.backend === 'claude' || value.backend === 'pi')
    && hashes.every(hash => typeof hash === 'string' && SHA256_PATTERN.test(hash));
}

/** One stored row, or null for a row an earlier schema wrote: those identities were keyed by a
 *  run surface that no longer exists, so they are left on disk and never linked to. */
function parseStoredRecord(text: string, line: number): ProductionAttemptIdentityRecord | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new Error(`Production attempt identity store malformed at line ${line}`);
  }
  if (isRecord(parsed) && typeof parsed.schema_version === 'string'
    && parsed.schema_version !== RECORD_SCHEMA) return null;
  if (!isRecord(parsed) || !storedRecordValid(parsed)) {
    throw new Error(`Production attempt identity store invalid at line ${line}`);
  }
  return parsed as unknown as ProductionAttemptIdentityRecord;
}

function sameRecord(
  left: ProductionAttemptIdentityRecord,
  right: ProductionAttemptIdentityRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type AttemptScope = Pick<ProductionAttemptIdentityRecord,
  'trial_id' | 'root_run_id' | 'session_id'>;

export interface ProductionAttemptIdentityScope {
  trialId: string;
  rootRunId: string;
}

function sameRun(
  record: ProductionAttemptIdentityRecord,
  scope: Pick<ProductionAttemptIdentityRecord, 'trial_id' | 'root_run_id'>,
): boolean {
  return record.trial_id === scope.trial_id && record.root_run_id === scope.root_run_id;
}

/**
 * Every attempt of a trial run belongs to its one benchmark session, and its attempts form a chain:
 * the first is the root, each later one (a resumed turn) names the attempt before it as its spawn
 * parent.
 */
export class ProductionAttemptIdentityRepo {
  private readonly byExecution = new Map<string, ProductionAttemptIdentityRecord>();
  private readonly byAttempt = new Map<string, ProductionAttemptIdentityRecord>();
  private readonly ordered: ProductionAttemptIdentityRecord[] = [];

  constructor(readonly filePath: string) {
    this.load();
  }

  private load(): void {
    let text: string;
    try { text = fs.readFileSync(this.filePath, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    text.split('\n').filter(Boolean).forEach((line, index) => {
      const record = parseStoredRecord(line, index + 1);
      if (record) this.remember(record);
    });
  }

  private latestSessionAttempt(scope: AttemptScope): ProductionAttemptIdentityRecord | null {
    for (let index = this.ordered.length - 1; index >= 0; index -= 1) {
      const candidate = this.ordered[index];
      if (sameRun(candidate, scope) && candidate.session_id === scope.session_id) return candidate;
    }
    return null;
  }

  private assertRunSession(scope: AttemptScope): void {
    const existing = this.ordered.find(record => sameRun(record, scope));
    if (existing && existing.session_id !== scope.session_id) {
      throw new Error('Production attempt identity cross-run session collision');
    }
  }

  resolveRootAttemptId(scope: AttemptScope, attemptId: string): string {
    this.assertRunSession(scope);
    return this.latestSessionAttempt(scope)?.root_attempt_id ?? attemptId;
  }

  resolveSpawnParentAttemptId(scope: AttemptScope): string | null {
    this.assertRunSession(scope);
    return this.latestSessionAttempt(scope)?.attempt_id ?? null;
  }

  private assertTopology(record: ProductionAttemptIdentityRecord): void {
    if (record.attempt_id !== `execution-${record.execution_id}`) {
      throw new Error('Production attempt identity collision between execution and attempt');
    }
    if (record.spawn_parent_attempt_id === record.attempt_id) {
      throw new Error('Production attempt identity cannot self-link');
    }
    const expectedRoot = this.resolveRootAttemptId(record, record.attempt_id);
    const expectedParent = this.resolveSpawnParentAttemptId(record);
    if (record.root_attempt_id !== expectedRoot
      || record.spawn_parent_attempt_id !== expectedParent) {
      throw new Error('Production attempt spawn topology is invalid');
    }
  }

  private remember(record: ProductionAttemptIdentityRecord): ProductionAttemptIdentityRecord {
    if (this.byExecution.has(record.execution_id) || this.byAttempt.has(record.attempt_id)) {
      throw new Error(`Production attempt identity collision: ${record.execution_id}`);
    }
    this.assertTopology(record);
    const immutable = Object.freeze({ ...record });
    this.byExecution.set(record.execution_id, immutable);
    this.byAttempt.set(record.attempt_id, immutable);
    this.ordered.push(immutable);
    return immutable;
  }

  get(executionId: string): ProductionAttemptIdentityRecord | null {
    return this.byExecution.get(executionId) ?? null;
  }

  list(scope: ProductionAttemptIdentityScope): readonly ProductionAttemptIdentityRecord[] {
    const trialId = requiredText(scope.trialId, 'trial identity');
    const rootRunId = requiredText(scope.rootRunId, 'root run identity');
    const records = this.ordered.filter(record => (
      record.trial_id === trialId && record.root_run_id === rootRunId
    ));
    if (records.length === 0) {
      throw new Error(`No production attempts found for ${trialId}/${rootRunId}`);
    }
    return Object.freeze([...records]);
  }

  firstRootAttempt(record: ProductionAttemptIdentityRecord): ProductionAttemptIdentityRecord | null {
    return this.ordered.find(candidate => sameRun(candidate, record)) ?? null;
  }

  append(record: ProductionAttemptIdentityRecord): ProductionAttemptIdentityRecord {
    const existing = this.get(record.execution_id);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw new Error(`Production attempt identity changed for execution ${record.execution_id}`);
      }
      return existing;
    }
    this.assertTopology(record);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.filePath, 'a', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return this.remember(record);
  }
}

function currentRevision(init: ProductionAttemptIdentityInit): ConfigurationRevision | null {
  return init.configurationRevision?.() ?? null;
}

export function initializeProductionAttemptIdentity(
  init: ProductionAttemptIdentityInit = {},
): void {
  activeState = null;
  resetProductionAttemptJournals();
  const identityStorePath = init.storePath ?? DEFAULT_STORE_PATH;
  const evidenceDir = path.dirname(identityStorePath);
  try {
    const repo = new ProductionAttemptIdentityRepo(identityStorePath);
    initializeProductionAttemptJournals({
      journalDir: path.join(evidenceDir, 'benchmark-attempt-journals'),
      storePath: path.join(evidenceDir, 'benchmark-attempt-journals.jsonl'),
    });
    activeState = {
      repo, revision: currentRevision(init), configurationRevision: init.configurationRevision,
    };
  } catch (error) {
    resetProductionAttemptJournals();
    throw error;
  }
}

export function resetProductionAttemptIdentity(): void {
  activeState = null;
  resetProductionAttemptJournals();
}

function assertStableState(state: ActiveIdentityState): void {
  const current = state.configurationRevision?.() ?? null;
  if (JSON.stringify(current) !== JSON.stringify(state.revision)) {
    throw new Error('Production benchmark configuration hot-reload drift detected');
  }
}

function requiredOption(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Production benchmark attempt is missing ${label}`);
  }
  return value;
}

function configuredRouteHost(spec: EngineSpec, backend: Backend): string | null {
  const route = backend === 'pi'
    ? spec.route.gatewayBaseUrl
    : (spec.env.sets?.ANTHROPIC_BASE_URL ?? spec.route.anthropicBaseUrl);
  if (!route) return null;
  try { return new URL(route).host; } catch {
    throw new Error(`Production benchmark resolved route is invalid: ${route}`);
  }
}

function assertSpawnMatchesProfile(
  spec: EngineSpec,
  profile: ResolvedProfileConfig,
): void {
  if (spec.model.id !== profile.model) {
    throw new Error('Production benchmark resolved model drifted before adapter spawn');
  }
  if ((spec.model.thinking ?? null) !== profile.thinking) {
    throw new Error('Production benchmark resolved thinking drifted before adapter spawn');
  }
  if (profile.backend === 'pi' && (spec.model.provider ?? null) !== profile.provider) {
    throw new Error('Production benchmark resolved provider drifted before adapter spawn');
  }
}

function assertProfile(
  input: FreezeAttemptInput,
  context: ProductionBenchmarkEvidenceContext,
): ResolvedProfileConfig {
  const profile = input.resolvedProfile;
  if (!profile) throw new Error('Production benchmark attempt is missing resolved profile');
  if (profile.fallback.length > 0) {
    throw new Error('Production benchmark identity refuses profiles with fallbacks');
  }
  if (profile.backend !== context.model_execution.cli_name
    || profile.backend !== input.adapterBackend) {
    throw new Error('Production benchmark backend differs from injected CLI identity');
  }
  assertSpawnMatchesProfile(input.spec, profile);
  return profile;
}

function maxOutputTokens(
  spec: EngineSpec,
  context: ProductionBenchmarkEvidenceContext,
): number | null {
  const injected = context.model_execution.max_output_tokens;
  const resolved = spec.model.maxOutputTokens ?? null;
  if (resolved !== injected) {
    throw new Error('Production benchmark max output token identity drifted');
  }
  return resolved;
}

type AttemptLinkage = Pick<ProductionAttemptIdentityRecord,
  'attempt_id' | 'root_attempt_id' | 'spawn_parent_attempt_id' | 'execution_id' | 'session_id'>;

type AttemptModel = Pick<ProductionAttemptIdentityRecord,
  'profile_name' | 'backend' | 'provider' | 'requested_model' |
  'model_execution_identity_hash' | 'role_tool_surface_hash'>;

function attemptLinkage(
  state: ActiveIdentityState,
  request: RunRequest,
  executionIdInput: string | null,
  context: ProductionBenchmarkEvidenceContext,
  existing: ProductionAttemptIdentityRecord | null,
): AttemptLinkage {
  const executionId = requiredOption(executionIdInput, 'execution identity');
  const attemptId = `execution-${executionId}`;
  const scope: AttemptScope = {
    trial_id: context.trial_id, root_run_id: context.root_run_id,
    session_id: requiredOption(request.session.sessionId, 'session identity'),
  };
  return {
    attempt_id: attemptId,
    root_attempt_id: existing?.root_attempt_id
      ?? state.repo.resolveRootAttemptId(scope, attemptId),
    spawn_parent_attempt_id: existing?.spawn_parent_attempt_id
      ?? state.repo.resolveSpawnParentAttemptId(scope),
    execution_id: executionId, session_id: scope.session_id,
  };
}

function modelExecutionHash(
  context: ProductionBenchmarkEvidenceContext,
  spec: EngineSpec,
  profile: ResolvedProfileConfig,
): string {
  const cli = context.model_execution;
  return computeModelExecutionIdentityHash({
    backend: profile.backend,
    requestedModel: profile.model,
    modelAliasPolicy: cli.model_alias_policy,
    providerProtocol: profile.provider,
    configuredRouteBaseHost: configuredRouteHost(spec, profile.backend),
    claudeCliVersion: profile.backend === 'claude' ? cli.cli_version : null,
    cliName: cli.cli_name,
    cliVersion: cli.cli_version,
    reasoningEffort: profile.thinking,
    maxOutputTokens: maxOutputTokens(spec, context),
    fallbackEmpty: true,
  });
}

function attemptModel(
  context: ProductionBenchmarkEvidenceContext,
  input: FreezeAttemptInput,
): AttemptModel {
  const profile = assertProfile(input, context);
  const directive = typeof input.request.benchmark?.identityDirective === 'string'
    ? input.request.benchmark.identityDirective : '';
  const roleSurface = roleSurfaceFromSpec(input.spec, directive);
  return {
    profile_name: profile.name,
    backend: profile.backend,
    provider: profile.provider,
    requested_model: profile.model,
    model_execution_identity_hash: modelExecutionHash(context, input.spec, profile),
    role_tool_surface_hash: computeRoleToolSurfaceHash(roleSurface),
  };
}

function buildRecord(
  state: ActiveIdentityState,
  input: FreezeAttemptInput,
  context: ProductionBenchmarkEvidenceContext,
  existing: ProductionAttemptIdentityRecord | null,
): ProductionAttemptIdentityRecord {
  return {
    schema_version: RECORD_SCHEMA,
    trial_id: context.trial_id,
    root_run_id: context.root_run_id,
    ...attemptLinkage(state, input.request, input.executionId, context, existing),
    ...attemptModel(context, input),
    bundle_manifest_hash: context.bundle_manifest_hash,
    frozen_at: new Date().toISOString(),
  };
}

function assertRootBaseline(
  repo: ProductionAttemptIdentityRepo,
  record: ProductionAttemptIdentityRecord,
): void {
  const root = repo.firstRootAttempt(record);
  if (!root) return;
  const rootFields = [
    'trial_id', 'root_run_id', 'bundle_manifest_hash', 'profile_name', 'backend', 'provider',
    'requested_model', 'model_execution_identity_hash',
  ] as const;
  if (rootFields.some(field => root[field] !== record[field])) {
    throw new Error('Production benchmark immutable root identity baseline drifted');
  }
  if (root.role_tool_surface_hash !== record.role_tool_surface_hash) {
    throw new Error('Production benchmark immutable role tool baseline drifted');
  }
}

export function freezeProductionAttemptIdentity(
  input: FreezeAttemptInput,
): ProductionAttemptIdentityRecord | null {
  const supplied = input.request.benchmark?.evidenceContext ?? null;
  if (supplied === undefined || supplied === null) return null;
  if (!activeState) {
    throw new Error('Production benchmark identity store is not initialized');
  }
  assertStableState(activeState);
  const context = parseProductionBenchmarkEvidenceContext(supplied);
  const executionId = requiredOption(input.executionId, 'execution identity');
  const existing = activeState.repo.get(executionId);
  const record = buildRecord(activeState, input, context, existing);
  const candidate = existing ? { ...record, frozen_at: existing.frozen_at } : record;
  assertRootBaseline(activeState.repo, candidate);
  return activeState.repo.append(candidate);
}

export function getProductionAttemptIdentity(
  executionId: string,
): ProductionAttemptIdentityRecord | null {
  return activeState?.repo.get(executionId) ?? null;
}

function activeRepo(): ProductionAttemptIdentityRepo {
  if (!activeState) {
    throw new Error('Production benchmark identity store is not initialized');
  }
  return activeState.repo;
}

export function listProductionAttemptIdentities(
  scope: ProductionAttemptIdentityScope,
): readonly ProductionAttemptIdentityRecord[] {
  return activeRepo().list(scope);
}
