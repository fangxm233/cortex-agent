// input:  typed thread evidence context and resolved production spawn
// output: immutable attempts, spawn topology, and strict reads
// pos:    Production benchmark identity persistence boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from '../../core/paths.js';
import type { AgentSpawnConfig, Backend } from '../../agent-adapter/types.js';
import type { ProductionBenchmarkEvidenceContext } from '../../core/types/thread-types.js';
import { parseProductionBenchmarkEvidenceContext } from '../../core/production-benchmark-evidence.js';
import type { RunAgentOptions } from '../agents/spawn-config.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import {
  computeModelExecutionIdentityHash, computeRoleToolSurfaceHash,
} from './identity.js';
import { roleSurfaceFromSpawnConfig } from './role-surface.js';
import {
  initializeProductionAttemptJournals, resetProductionAttemptJournals,
} from './production-attempt-journal.js';

const RECORD_SCHEMA = 'cortex-production-attempt-identity/2';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_STORE_PATH = path.join(STORE_DIR, 'benchmark-attempt-identities.jsonl');
const RECORD_KEYS = [
  'schema_version', 'trial_id', 'root_run_id', 'attempt_id', 'root_attempt_id',
  'spawn_parent_attempt_id', 'execution_id', 'thread_id', 'parent_thread_id',
  'root_thread_id', 'task_id',
  'task_project', 'dispatch_generation', 'template', 'role', 'stage', 'profile_name',
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
  thread_id: string;
  parent_thread_id: string | null;
  root_thread_id: string;
  task_id: string;
  task_project: string | null;
  dispatch_generation: string | null;
  template: string;
  role: string;
  stage: string | null;
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
  threads: number;
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
  spawnConfig: AgentSpawnConfig;
  options: RunAgentOptions;
  resolvedProfile: ResolvedProfileConfig | undefined;
}

let initialized = false;
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

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredText(value, label);
}

function isNullableString(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function storedRecordValid(value: Record<string, unknown>): boolean {
  const strings = [
    'trial_id', 'root_run_id', 'attempt_id', 'root_attempt_id', 'execution_id',
    'thread_id', 'root_thread_id', 'task_id', 'template', 'role', 'profile_name',
    'requested_model', 'model_execution_identity_hash', 'role_tool_surface_hash',
    'bundle_manifest_hash', 'frozen_at',
  ];
  const nullable = [
    'spawn_parent_attempt_id', 'parent_thread_id', 'task_project',
    'dispatch_generation', 'stage', 'provider',
  ];
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

function parseStoredRecord(text: string, line: number): ProductionAttemptIdentityRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new Error(`Production attempt identity store malformed at line ${line}`);
  }
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
  'trial_id' | 'root_run_id' | 'thread_id' | 'parent_thread_id' | 'root_thread_id'>;

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
      this.remember(parseStoredRecord(line, index + 1));
    });
  }

  private latestThreadAttempt(
    scope: AttemptScope,
    threadId: string,
  ): ProductionAttemptIdentityRecord | null {
    for (let index = this.ordered.length - 1; index >= 0; index -= 1) {
      const candidate = this.ordered[index];
      if (sameRun(candidate, scope) && candidate.root_thread_id === scope.root_thread_id
        && candidate.thread_id === threadId) return candidate;
    }
    return null;
  }

  private assertRunRoot(scope: AttemptScope): void {
    const existing = this.ordered.find(record => sameRun(record, scope));
    if (existing && existing.root_thread_id !== scope.root_thread_id) {
      throw new Error('Production attempt identity cross-run root thread collision');
    }
  }

  resolveRootAttemptId(scope: AttemptScope, attemptId: string): string {
    this.assertRunRoot(scope);
    const root = this.latestThreadAttempt(scope, scope.root_thread_id);
    if (root) return root.root_attempt_id;
    if (scope.thread_id === scope.root_thread_id) return attemptId;
    throw new Error('Production benchmark root attempt is missing before child adapter spawn');
  }

  private firstThreadSpawnParent(scope: AttemptScope): string | null {
    if (scope.thread_id === scope.root_thread_id) {
      if (scope.parent_thread_id !== null) {
        throw new Error('Production root attempt cannot declare a parent thread');
      }
      return null;
    }
    if (!scope.parent_thread_id) {
      throw new Error('Production benchmark child attempt is missing parent thread identity');
    }
    const parent = this.latestThreadAttempt(scope, scope.parent_thread_id);
    if (!parent) {
      throw new Error('Production benchmark spawn parent attempt is missing before child adapter spawn');
    }
    return parent.attempt_id;
  }

  resolveSpawnParentAttemptId(scope: AttemptScope): string | null {
    this.assertRunRoot(scope);
    const previous = this.latestThreadAttempt(scope, scope.thread_id);
    if (!previous) return this.firstThreadSpawnParent(scope);
    if (previous.parent_thread_id !== scope.parent_thread_id) {
      throw new Error('Production attempt thread ancestry changed across executions');
    }
    return previous.attempt_id;
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
    const parent = record.spawn_parent_attempt_id
      ? this.byAttempt.get(record.spawn_parent_attempt_id) : null;
    if (parent && !sameRun(parent, record)) {
      throw new Error('Production attempt spawn parent crosses trial or root run');
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

  read(executionId: string): ProductionAttemptIdentityRecord {
    const record = this.get(requiredText(executionId, 'execution identity'));
    if (!record) throw new Error(`Production attempt identity not found: ${executionId}`);
    return record;
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
    return this.ordered.find(candidate => sameRun(candidate, record)
      && candidate.thread_id === record.root_thread_id
      && candidate.root_thread_id === record.root_thread_id) ?? null;
  }

  firstRoleAttempt(record: ProductionAttemptIdentityRecord): ProductionAttemptIdentityRecord | null {
    return this.ordered.find(candidate => sameRun(candidate, record)
      && candidate.root_thread_id === record.root_thread_id
      && candidate.template === record.template && candidate.role === record.role
      && candidate.stage === record.stage) ?? null;
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
  initialized = false;
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
    initialized = true;
  } catch (error) {
    resetProductionAttemptJournals();
    throw error;
  }
}

export function resetProductionAttemptIdentity(): void {
  initialized = false;
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

function configuredRouteHost(config: AgentSpawnConfig, backend: Backend): string | null {
  const route = backend === 'pi'
    ? config.piGatewayBaseUrl
    : (config.env?.ANTHROPIC_BASE_URL ?? config.anthropicBaseUrl);
  if (!route) return null;
  try { return new URL(route).host; } catch {
    throw new Error(`Production benchmark resolved route is invalid: ${route}`);
  }
}

function assertSpawnMatchesProfile(
  config: AgentSpawnConfig,
  profile: ResolvedProfileConfig,
): void {
  if (config.model !== profile.model) {
    throw new Error('Production benchmark resolved model drifted before adapter spawn');
  }
  if ((config.thinking ?? null) !== profile.thinking) {
    throw new Error('Production benchmark resolved thinking drifted before adapter spawn');
  }
  if (profile.backend === 'pi' && (config.piProvider ?? null) !== profile.provider) {
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
  assertSpawnMatchesProfile(input.spawnConfig, profile);
  return profile;
}

function maxOutputTokens(
  config: AgentSpawnConfig,
  context: ProductionBenchmarkEvidenceContext,
): number | null {
  const injected = context.model_execution.max_output_tokens;
  const resolved = config.piModelMaxTokens ?? null;
  if (resolved !== injected) {
    throw new Error('Production benchmark max output token identity drifted');
  }
  return resolved;
}

type AttemptLinkage = Pick<ProductionAttemptIdentityRecord,
  'attempt_id' | 'root_attempt_id' | 'spawn_parent_attempt_id' | 'execution_id' |
  'thread_id' | 'parent_thread_id' | 'root_thread_id' | 'task_id' |
  'task_project' | 'dispatch_generation'>;

type AttemptTask = Pick<ProductionAttemptIdentityRecord,
  'task_id' | 'task_project' | 'dispatch_generation'>;

type AttemptShape = Pick<ProductionAttemptIdentityRecord,
  'template' | 'role' | 'stage'>;

type AttemptModel = Pick<ProductionAttemptIdentityRecord,
  'profile_name' | 'backend' | 'provider' | 'requested_model' |
  'model_execution_identity_hash' | 'role_tool_surface_hash'>;

function attemptTask(
  options: RunAgentOptions,
  context: ProductionBenchmarkEvidenceContext,
): AttemptTask {
  if (!options.taskId) {
    return { task_id: context.trial_id, task_project: null, dispatch_generation: null };
  }
  return {
    task_id: options.taskId,
    task_project: requiredOption(options.taskProject, 'task project'),
    dispatch_generation: requiredOption(options.taskGeneration, 'dispatch generation'),
  };
}

function attemptLinkage(
  state: ActiveIdentityState,
  options: RunAgentOptions,
  context: ProductionBenchmarkEvidenceContext,
  existing: ProductionAttemptIdentityRecord | null,
): AttemptLinkage {
  const executionId = requiredOption(options.executionId, 'execution identity');
  const attemptId = `execution-${executionId}`;
  const scope: AttemptScope = {
    trial_id: context.trial_id, root_run_id: context.root_run_id,
    thread_id: requiredOption(options.threadId, 'thread identity'),
    parent_thread_id: nullableText(options.parentThreadId ?? null, 'parent thread identity'),
    root_thread_id: requiredOption(options.rootThreadId, 'root thread identity'),
  };
  return {
    attempt_id: attemptId,
    root_attempt_id: existing?.root_attempt_id
      ?? state.repo.resolveRootAttemptId(scope, attemptId),
    spawn_parent_attempt_id: existing?.spawn_parent_attempt_id
      ?? state.repo.resolveSpawnParentAttemptId(scope),
    execution_id: executionId, thread_id: scope.thread_id,
    parent_thread_id: scope.parent_thread_id, root_thread_id: scope.root_thread_id,
    ...attemptTask(options, context),
  };
}

function attemptShape(options: RunAgentOptions): AttemptShape {
  return {
    template: requiredOption(options.templateName, 'template identity'),
    role: requiredOption(options.agentSlotId, 'role identity'),
    stage: nullableText(options.stage ?? null, 'stage identity'),
  };
}

function modelExecutionHash(
  context: ProductionBenchmarkEvidenceContext,
  config: AgentSpawnConfig,
  profile: ResolvedProfileConfig,
): string {
  const cli = context.model_execution;
  return computeModelExecutionIdentityHash({
    backend: profile.backend,
    requestedModel: profile.model,
    modelAliasPolicy: cli.model_alias_policy,
    providerProtocol: profile.provider,
    configuredRouteBaseHost: configuredRouteHost(config, profile.backend),
    claudeCliVersion: profile.backend === 'claude' ? cli.cli_version : null,
    cliName: cli.cli_name,
    cliVersion: cli.cli_version,
    reasoningEffort: profile.thinking,
    maxOutputTokens: maxOutputTokens(config, context),
    fallbackEmpty: true,
  });
}

function attemptModel(
  context: ProductionBenchmarkEvidenceContext,
  input: FreezeAttemptInput,
): AttemptModel {
  const profile = assertProfile(input, context);
  const directive = typeof input.options.identityDirective === 'string'
    ? input.options.identityDirective : '';
  const roleSurface = roleSurfaceFromSpawnConfig(
    input.spawnConfig, directive, input.spawnConfig.benchmarkPolicyGuard,
  );
  return {
    profile_name: profile.name,
    backend: profile.backend,
    provider: profile.provider,
    requested_model: profile.model,
    model_execution_identity_hash: modelExecutionHash(context, input.spawnConfig, profile),
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
    ...attemptLinkage(state, input.options, context, existing),
    ...attemptShape(input.options),
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
  const role = repo.firstRoleAttempt(record);
  if (role && role.role_tool_surface_hash !== record.role_tool_surface_hash) {
    throw new Error('Production benchmark immutable role tool baseline drifted');
  }
}

export function freezeProductionAttemptIdentity(
  input: FreezeAttemptInput,
): ProductionAttemptIdentityRecord | null {
  const supplied = input.options.productionBenchmarkEvidenceContext;
  if (supplied === undefined || supplied === null) return null;
  if (!initialized || !activeState) {
    throw new Error('Production benchmark identity store is not initialized');
  }
  assertStableState(activeState);
  const context = parseProductionBenchmarkEvidenceContext(supplied);
  const executionId = requiredOption(input.options.executionId, 'execution identity');
  const existing = activeState.repo.get(executionId);
  const record = buildRecord(activeState, input, context, existing);
  const candidate = existing ? { ...record, frozen_at: existing.frozen_at } : record;
  assertRootBaseline(activeState.repo, candidate);
  return activeState.repo.append(candidate);
}

export function productionAttemptEvidenceEnabled(options: RunAgentOptions): boolean {
  return initialized && activeState !== null
    && options.productionBenchmarkEvidenceContext != null;
}

export function getProductionAttemptIdentity(
  executionId: string,
): ProductionAttemptIdentityRecord | null {
  return activeState?.repo.get(executionId) ?? null;
}

function activeRepo(): ProductionAttemptIdentityRepo {
  if (!initialized || !activeState) {
    throw new Error('Production benchmark identity store is not initialized');
  }
  return activeState.repo;
}

export function readProductionAttemptIdentity(
  executionId: string,
): ProductionAttemptIdentityRecord {
  return activeRepo().read(executionId);
}

export function listProductionAttemptIdentities(
  scope: ProductionAttemptIdentityScope,
): readonly ProductionAttemptIdentityRecord[] {
  return activeRepo().list(scope);
}
