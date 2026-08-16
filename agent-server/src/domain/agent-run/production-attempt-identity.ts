// input:  launcher identity input and resolved production spawn
// output: immutable pre-spawn attempt identity records
// pos:    Production benchmark identity persistence boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, STORE_DIR } from '../../core/paths.js';
import type { AgentSpawnConfig, Backend } from '../../agent-adapter/types.js';
import type { RunAgentOptions } from '../agents/spawn-config.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import {
  computeModelExecutionIdentityHash, computeRoleToolSurfaceHash,
  type IdentityJsonValue,
} from './identity.js';
import { mintAttemptId } from '../benchmark/attempt-record.js';
import { roleSurfaceFromSpawnConfig } from './role-surface.js';

const INPUT_SCHEMA = 'cortex-production-attempt-identity-input/1';
const RECORD_SCHEMA = 'cortex-production-attempt-identity/1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_INPUT_PATH = path.join(CONFIG_DIR, 'benchmark-attempt-identity.json');
const DEFAULT_STORE_PATH = path.join(STORE_DIR, 'benchmark-attempt-identities.jsonl');
const RECORD_KEYS = [
  'schema_version', 'trial_id', 'root_run_id', 'attempt_id', 'root_attempt_id',
  'execution_id', 'thread_id', 'parent_thread_id', 'root_thread_id', 'task_id',
  'task_project', 'dispatch_generation', 'template', 'role', 'stage', 'profile_name',
  'backend', 'provider', 'requested_model', 'model_execution_identity_hash',
  'role_tool_surface_hash', 'bundle_manifest_hash', 'frozen_at',
] as const;

interface ModelExecutionInput {
  model_alias_policy: IdentityJsonValue;
  cli_name: Backend;
  cli_version: string;
  max_output_tokens: number | null;
}

interface ProductionAttemptIdentityInput {
  schema_version: typeof INPUT_SCHEMA;
  trial_id: string;
  root_run_id: string;
  bundle_manifest_hash: string;
  model_execution: ModelExecutionInput;
}

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
  inputPath?: string;
  storePath?: string;
  configurationRevision?: () => ConfigurationRevision;
}

interface ActiveIdentityState {
  inputPath: string;
  inputText: string;
  input: ProductionAttemptIdentityInput;
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
  return new Error(`Production benchmark identity input invalid: ${detail}`);
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

function parseModelExecution(value: unknown): ModelExecutionInput {
  if (!isRecord(value) || !exactKeys(value, [
    'model_alias_policy', 'cli_name', 'cli_version', 'max_output_tokens',
  ])) throw identityInputError('model_execution');
  if (value.cli_name !== 'claude' && value.cli_name !== 'pi') {
    throw identityInputError('model_execution.cli_name');
  }
  const max = value.max_output_tokens;
  if (max !== null && (!Number.isInteger(max) || Number(max) <= 0)) {
    throw identityInputError('model_execution.max_output_tokens');
  }
  return {
    model_alias_policy: value.model_alias_policy as IdentityJsonValue,
    cli_name: value.cli_name,
    cli_version: requiredText(value.cli_version, 'model_execution.cli_version'),
    max_output_tokens: max as number | null,
  };
}

function parseIdentityInput(text: string): ProductionAttemptIdentityInput {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw identityInputError('JSON'); }
  if (!isRecord(parsed) || !exactKeys(parsed, [
    'schema_version', 'trial_id', 'root_run_id', 'bundle_manifest_hash', 'model_execution',
  ])) throw identityInputError('envelope');
  if (parsed.schema_version !== INPUT_SCHEMA) throw identityInputError('schema_version');
  const bundle = requiredText(parsed.bundle_manifest_hash, 'bundle_manifest_hash');
  if (!SHA256_PATTERN.test(bundle)) throw identityInputError('bundle_manifest_hash');
  return {
    schema_version: INPUT_SCHEMA,
    trial_id: requiredText(parsed.trial_id, 'trial_id'),
    root_run_id: requiredText(parsed.root_run_id, 'root_run_id'),
    bundle_manifest_hash: bundle,
    model_execution: parseModelExecution(parsed.model_execution),
  };
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
  const inputPath = init.inputPath ?? DEFAULT_INPUT_PATH;
  initialized = true;
  if (!fs.existsSync(inputPath)) {
    activeState = null;
    return;
  }
  const inputText = fs.readFileSync(inputPath, 'utf8');
  activeState = {
    inputPath, inputText, input: parseIdentityInput(inputText),
    repo: new ProductionAttemptIdentityRepo(init.storePath ?? DEFAULT_STORE_PATH),
    revision: currentRevision(init), configurationRevision: init.configurationRevision,
  };
}

export function resetProductionAttemptIdentity(): void {
  initialized = false;
  activeState = null;
}

function assertStableState(state: ActiveIdentityState): void {
  if (fs.readFileSync(state.inputPath, 'utf8') !== state.inputText) {
    throw new Error('Production benchmark identity input changed after startup');
  }
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
  state: ActiveIdentityState,
): ResolvedProfileConfig {
  const profile = input.resolvedProfile;
  if (!profile) throw new Error('Production benchmark attempt is missing resolved profile');
  if (profile.fallback.length > 0) {
    throw new Error('Production benchmark identity refuses profiles with fallbacks');
  }
  if (profile.backend !== state.input.model_execution.cli_name
    || profile.backend !== input.adapterBackend) {
    throw new Error('Production benchmark backend differs from injected CLI identity');
  }
  assertSpawnMatchesProfile(input.spawnConfig, profile);
  return profile;
}

function maxOutputTokens(config: AgentSpawnConfig, state: ActiveIdentityState): number | null {
  const injected = state.input.model_execution.max_output_tokens;
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

function attemptLinkage(
  state: ActiveIdentityState,
  options: RunAgentOptions,
): AttemptLinkage {
  const executionId = requiredOption(options.executionId, 'execution identity');
  const threadId = requiredOption(options.threadId, 'thread identity');
  const rootThreadId = requiredOption(options.rootThreadId, 'root thread identity');
  const taskProject = options.taskId ? requiredOption(options.taskProject, 'task project') : null;
  const generation = options.taskId
    ? requiredOption(options.taskGeneration, 'dispatch generation') : null;
  return {
    attempt_id: mintAttemptId(state.input.root_run_id, threadId),
    root_attempt_id: mintAttemptId(state.input.root_run_id, rootThreadId),
    execution_id: executionId,
    thread_id: threadId,
    parent_thread_id: nullableText(options.parentThreadId ?? null, 'parent thread identity'),
    root_thread_id: rootThreadId,
    task_id: options.taskId ?? state.input.trial_id,
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
  state: ActiveIdentityState,
  config: AgentSpawnConfig,
  profile: ResolvedProfileConfig,
): string {
  const cli = state.input.model_execution;
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
    maxOutputTokens: maxOutputTokens(config, state),
    fallbackEmpty: true,
  });
}

function attemptModel(
  state: ActiveIdentityState,
  input: FreezeAttemptInput,
): AttemptModel {
  const profile = assertProfile(input, state);
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
    model_execution_identity_hash: modelExecutionHash(state, input.spawnConfig, profile),
    role_tool_surface_hash: computeRoleToolSurfaceHash(roleSurface),
  };
}

function buildRecord(
  state: ActiveIdentityState,
  input: FreezeAttemptInput,
): ProductionAttemptIdentityRecord {
  return {
    schema_version: RECORD_SCHEMA,
    trial_id: state.input.trial_id,
    root_run_id: state.input.root_run_id,
    ...attemptLinkage(state, input.options),
    ...attemptShape(input.options),
    ...attemptModel(state, input),
    bundle_manifest_hash: state.input.bundle_manifest_hash,
    frozen_at: new Date().toISOString(),
  };
}

export function freezeProductionAttemptIdentity(
  input: FreezeAttemptInput,
): ProductionAttemptIdentityRecord | null {
  if (!initialized || !activeState) return null;
  assertStableState(activeState);
  const record = buildRecord(activeState, input);
  const existing = activeState.repo.get(record.execution_id);
  const candidate = existing ? { ...record, frozen_at: existing.frozen_at } : record;
  return activeState.repo.append(candidate);
}

export function getProductionAttemptIdentity(
  executionId: string,
): ProductionAttemptIdentityRecord | null {
  return activeState?.repo.get(executionId) ?? null;
}
