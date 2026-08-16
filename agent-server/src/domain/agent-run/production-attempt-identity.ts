// input:  typed thread evidence context and resolved production spawn
// output: immutable execution attempts and root identity baselines
// pos:    Production benchmark identity persistence boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from '../../core/paths.js';
import type { AgentSpawnConfig, Backend } from '../../agent-adapter/types.js';
import type { ProductionBenchmarkEvidenceContext } from '../../core/types/thread-types.js';
import type { RunAgentOptions } from '../agents/spawn-config.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import {
  computeModelExecutionIdentityHash, computeRoleToolSurfaceHash,
} from './identity.js';
import { roleSurfaceFromSpawnConfig } from './role-surface.js';

const CONTEXT_SCHEMA = 'cortex-production-benchmark-evidence-context/1';
const RECORD_SCHEMA = 'cortex-production-attempt-identity/1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_STORE_PATH = path.join(STORE_DIR, 'benchmark-attempt-identities.jsonl');
const RECORD_KEYS = [
  'schema_version', 'trial_id', 'root_run_id', 'attempt_id', 'root_attempt_id',
  'execution_id', 'thread_id', 'parent_thread_id', 'root_thread_id', 'task_id',
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

type ModelExecutionContext = ProductionBenchmarkEvidenceContext['model_execution'];

function isIdentityJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isIdentityJsonValue);
  return isRecord(value) && Object.values(value).every(isIdentityJsonValue);
}

function parseModelExecution(value: unknown): ModelExecutionContext {
  if (!isRecord(value) || !exactKeys(value, [
    'model_alias_policy', 'cli_name', 'cli_version', 'max_output_tokens',
  ])) throw identityInputError('model_execution');
  if (!isIdentityJsonValue(value.model_alias_policy)) {
    throw identityInputError('model_execution.model_alias_policy');
  }
  if (value.cli_name !== 'claude' && value.cli_name !== 'pi') {
    throw identityInputError('model_execution.cli_name');
  }
  const max = value.max_output_tokens;
  if (max !== null && (!Number.isInteger(max) || Number(max) <= 0)) {
    throw identityInputError('model_execution.max_output_tokens');
  }
  return {
    model_alias_policy: value.model_alias_policy as ModelExecutionContext['model_alias_policy'],
    cli_name: value.cli_name,
    cli_version: requiredText(value.cli_version, 'model_execution.cli_version'),
    max_output_tokens: max as number | null,
  };
}

function parseEvidenceContext(value: unknown): ProductionBenchmarkEvidenceContext {
  if (!isRecord(value) || !exactKeys(value, [
    'schema_version', 'trial_id', 'root_run_id', 'bundle_manifest_hash', 'model_execution',
  ])) throw identityInputError('evidence context envelope');
  if (value.schema_version !== CONTEXT_SCHEMA) throw identityInputError('schema_version');
  const bundle = requiredText(value.bundle_manifest_hash, 'bundle_manifest_hash');
  if (!SHA256_PATTERN.test(bundle)) throw identityInputError('bundle_manifest_hash');
  return Object.freeze({
    schema_version: CONTEXT_SCHEMA,
    trial_id: requiredText(value.trial_id, 'trial_id'),
    root_run_id: requiredText(value.root_run_id, 'root_run_id'),
    bundle_manifest_hash: bundle,
    model_execution: Object.freeze(parseModelExecution(value.model_execution)),
  });
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
  const nullable = ['parent_thread_id', 'task_project', 'dispatch_generation', 'stage', 'provider'];
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

export class ProductionAttemptIdentityRepo {
  private readonly records = new Map<string, ProductionAttemptIdentityRecord>();

  constructor(readonly filePath: string) {
    this.load();
  }

  private load(): void {
    let text: string;
    try { text = fs.readFileSync(this.filePath, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const lines = text.split('\n').filter(Boolean);
    lines.forEach((line, index) => this.remember(parseStoredRecord(line, index + 1)));
  }

  private remember(record: ProductionAttemptIdentityRecord): ProductionAttemptIdentityRecord {
    const existing = this.records.get(record.execution_id);
    if (existing && !sameRecord(existing, record)) {
      throw new Error(`Production attempt identity changed for execution ${record.execution_id}`);
    }
    if (existing) return existing;
    const immutable = Object.freeze({ ...record });
    this.records.set(record.execution_id, immutable);
    return immutable;
  }

  get(executionId: string): ProductionAttemptIdentityRecord | null {
    return this.records.get(executionId) ?? null;
  }

  firstRootAttempt(rootThreadId: string): ProductionAttemptIdentityRecord | null {
    for (const record of this.records.values()) {
      if (record.thread_id === rootThreadId && record.root_thread_id === rootThreadId) return record;
    }
    return null;
  }

  firstRoleAttempt(record: ProductionAttemptIdentityRecord): ProductionAttemptIdentityRecord | null {
    for (const candidate of this.records.values()) {
      const sameRole = candidate.root_thread_id === record.root_thread_id
        && candidate.template === record.template && candidate.role === record.role
        && candidate.stage === record.stage;
      if (sameRole) return candidate;
    }
    return null;
  }

  append(record: ProductionAttemptIdentityRecord): ProductionAttemptIdentityRecord {
    const existing = this.get(record.execution_id);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw new Error(`Production attempt identity changed for execution ${record.execution_id}`);
      }
      return existing;
    }
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
  initialized = true;
  activeState = {
    repo: new ProductionAttemptIdentityRepo(init.storePath ?? DEFAULT_STORE_PATH),
    revision: currentRevision(init), configurationRevision: init.configurationRevision,
  };
}

export function resetProductionAttemptIdentity(): void {
  initialized = false;
  activeState = null;
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
  'attempt_id' | 'root_attempt_id' | 'execution_id' | 'thread_id' |
  'parent_thread_id' | 'root_thread_id' | 'task_id' | 'task_project' | 'dispatch_generation'>;

type AttemptShape = Pick<ProductionAttemptIdentityRecord,
  'template' | 'role' | 'stage'>;

type AttemptModel = Pick<ProductionAttemptIdentityRecord,
  'profile_name' | 'backend' | 'provider' | 'requested_model' |
  'model_execution_identity_hash' | 'role_tool_surface_hash'>;

function rootAttemptId(
  repo: ProductionAttemptIdentityRepo,
  attemptId: string,
  threadId: string,
  rootThreadId: string,
): string {
  const root = repo.firstRootAttempt(rootThreadId);
  if (root) return root.attempt_id;
  if (threadId === rootThreadId) return attemptId;
  throw new Error('Production benchmark root attempt is missing before child adapter spawn');
}

function attemptLinkage(
  state: ActiveIdentityState,
  options: RunAgentOptions,
  context: ProductionBenchmarkEvidenceContext,
): AttemptLinkage {
  const executionId = requiredOption(options.executionId, 'execution identity');
  const threadId = requiredOption(options.threadId, 'thread identity');
  const rootThreadId = requiredOption(options.rootThreadId, 'root thread identity');
  const taskProject = options.taskId ? requiredOption(options.taskProject, 'task project') : null;
  const generation = options.taskId
    ? requiredOption(options.taskGeneration, 'dispatch generation') : null;
  const attemptId = `execution-${executionId}`;
  return {
    attempt_id: attemptId,
    root_attempt_id: rootAttemptId(state.repo, attemptId, threadId, rootThreadId),
    execution_id: executionId,
    thread_id: threadId,
    parent_thread_id: nullableText(options.parentThreadId ?? null, 'parent thread identity'),
    root_thread_id: rootThreadId,
    task_id: options.taskId ?? context.trial_id,
    task_project: taskProject,
    dispatch_generation: generation,
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
): ProductionAttemptIdentityRecord {
  return {
    schema_version: RECORD_SCHEMA,
    trial_id: context.trial_id,
    root_run_id: context.root_run_id,
    ...attemptLinkage(state, input.options, context),
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
  const root = repo.firstRootAttempt(record.root_thread_id);
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
  const context = parseEvidenceContext(supplied);
  const record = buildRecord(activeState, input, context);
  const existing = activeState.repo.get(record.execution_id);
  const candidate = existing ? { ...record, frozen_at: existing.frozen_at } : record;
  assertRootBaseline(activeState.repo, candidate);
  return activeState.repo.append(candidate);
}

export function getProductionAttemptIdentity(
  executionId: string,
): ProductionAttemptIdentityRecord | null {
  return activeState?.repo.get(executionId) ?? null;
}
