// input:  parsed arm and phase-A resolution documents
// output: validated v2 arms and versioned resolution shapes
// pos:    Closed schema and ordered cross-field validation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { z } from 'zod';

export const ARM_SCHEMA_VERSION = 'cortex-benchmark-arm/2' as const;
export const ARM_RESOLUTION_SCHEMA_VERSION = 'cortex-benchmark-arm-resolution/1' as const;

export type ArmKind = 'cortex' | 'vendor-baseline';
export type OrchestrationMode = 'direct' | 'coder-review' | 'manager';
export type CoderReviewVariant = 'audit-retry' | 'reviewer-fix';
export type VendorAgent = 'claude-code' | 'pi' | 'codex';

export interface ArmLimits {
  max_thread_starts: number;
  max_parent_questions: number;
  max_task_depth: number;
  max_tasks: number;
  max_provider_requests: number;
  max_resident_agent_processes: number;
  max_cost_usd: string;
  deadline_seconds: number;
}

export interface ArmOrchestration {
  mode: OrchestrationMode;
  coder_review_variant?: CoderReviewVariant;
  ask_manager: boolean;
}

export interface ArmDefinition {
  schema_version: typeof ARM_SCHEMA_VERSION;
  kind: ArmKind;
  name: string;
  backend?: 'claude' | 'pi';
  vendor_agent?: VendorAgent;
  provider: string | null;
  model: string;
  credential_capability: string;
  orchestration?: ArmOrchestration;
  limits: ArmLimits;
}

export type ArmValidationReason =
  | 'arm_schema_invalid'
  | 'arm_field_conflict'
  | 'coder_review_variant_invalid'
  | 'ask_manager_unsupported_mode'
  | 'limit_out_of_range'
  | 'capacity_rule_violated';

export class ArmValidationError extends Error {
  constructor(
    readonly reason: ArmValidationReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'ArmValidationError';
  }
}

const safeName = /^[A-Za-z0-9._-]+$/;
const safeProvider = /^[A-Za-z0-9_-]+$/;
const decimal = /^\d+(?:\.\d+)?$/;

const limitsSchema = z.object({
  max_thread_starts: z.number(),
  max_parent_questions: z.number(),
  max_task_depth: z.number(),
  max_tasks: z.number(),
  max_provider_requests: z.number(),
  max_resident_agent_processes: z.number(),
  max_cost_usd: z.string(),
  deadline_seconds: z.number(),
}).strict();

const orchestrationSchema = z.object({
  mode: z.enum(['direct', 'coder-review', 'manager']),
  coder_review_variant: z.string().optional(),
  ask_manager: z.boolean().optional().default(false),
}).strict();

const armSchema = z.object({
  schema_version: z.literal(ARM_SCHEMA_VERSION),
  kind: z.enum(['cortex', 'vendor-baseline']),
  name: z.string().min(1).regex(safeName),
  backend: z.enum(['claude', 'pi']).optional(),
  vendor_agent: z.enum(['claude-code', 'pi', 'codex']).optional(),
  provider: z.string().regex(safeProvider).nullable().optional().default(null),
  model: z.string().min(1),
  credential_capability: z.string().min(1),
  orchestration: orchestrationSchema.optional(),
  limits: limitsSchema,
}).strict();

const namedStrings = z.record(z.string(), z.string().min(1));
const credentialProjectionSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['unsupported', 'offline-contract-passed', 'live-handshake-passed']),
  key: z.object({
    runner_or_backend: z.string().min(1),
    provider: z.string(),
    protocol: z.string(),
    credential_kind: z.string().min(1),
    proxy_adapter_version: z.string().min(1),
  }).strict(),
}).strict();
const roleAssetSchema = z.object({
  system_prompt_path: z.string().min(1),
  directive_path: z.string().min(1),
  tools: z.array(z.string().min(1)).min(1),
  plugin_dirs: z.array(z.string().min(1)),
  mcp_composition: z.enum(['direct', 'thread-control', 'none', 'benchmark-thread-run']),
  mcp_config_paths: z.array(z.string().min(1)),
  disable_hooks: z.literal(true),
  benchmark_policy_guard: z.unknown().optional(),
}).strict();
const armResolutionSchema = z.object({
  schema_version: z.literal(ARM_RESOLUTION_SCHEMA_VERSION),
  arm: z.unknown(), arm_path: z.string().min(1), trial_id: z.string().min(1),
  root_run_id: z.string().min(1),
  task: z.object({
    task_id: z.string().min(1), image_ref: z.string().min(1), image_digest: z.string(),
  }).strict(),
  profile_name: z.string().min(1), paid_run: z.boolean(),
  credential_capabilities: z.array(credentialProjectionSchema),
  credential: z.object({
    upstream_base_url: z.string().min(1), route_identity_host: z.string().min(1),
    proxy_base_url: z.string().min(1), dummy_token_ref: z.string().min(1),
  }).strict(),
  cli_artifact: z.object({ path: z.string().min(1), version: z.string().min(1) }).strict(),
  model_alias_policy: z.unknown(), roles: z.record(z.string(), roleAssetSchema),
  thread_templates: namedStrings, thread_agents: namedStrings,
  artifact_inventory_spec: z.unknown(), expected_asset_hashes: namedStrings.optional(),
  pi_benchmark_capability_proven: z.boolean().optional(),
}).strict();

function fail(reason: ArmValidationReason, detail: string): never {
  throw new ArmValidationError(reason, detail);
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateCountLimits(limits: ArmLimits): void {
  const nonnegative = [
    limits.max_parent_questions, limits.max_task_depth, limits.max_tasks,
  ];
  if (!nonnegative.every(isNonnegativeInteger)) {
    fail('limit_out_of_range', 'question, depth, and task limits must be nonnegative integers');
  }
  if (!Number.isSafeInteger(limits.max_thread_starts)
    || ![0, 1].includes(limits.max_thread_starts)) {
    fail('limit_out_of_range', 'max_thread_starts must be 0 or 1');
  }
}

function validatePositiveLimits(limits: ArmLimits): void {
  const positive = [
    limits.max_provider_requests,
    limits.max_resident_agent_processes,
    limits.deadline_seconds,
  ];
  if (!positive.every(value => Number.isSafeInteger(value) && value > 0)) {
    fail('limit_out_of_range', 'provider, resident, and deadline limits must be positive integers');
  }
}

function validateCostLimit(value: string): void {
  if (!decimal.test(value)) fail('limit_out_of_range', 'max_cost_usd must be a decimal string');
  if (!/[1-9]/.test(value)) fail('limit_out_of_range', 'max_cost_usd must be positive');
}

function validateLimitRanges(limits: ArmLimits): void {
  validateCountLimits(limits);
  validatePositiveLimits(limits);
  validateCostLimit(limits.max_cost_usd);
}

function validateKindFields(arm: ArmDefinition): void {
  const cortexValid = arm.backend !== undefined
    && arm.orchestration !== undefined && arm.vendor_agent === undefined;
  if (arm.kind === 'cortex' && !cortexValid) {
    fail('arm_field_conflict', 'cortex requires backend and orchestration, without vendor_agent');
  }
  const baselineValid = arm.vendor_agent !== undefined
    && arm.backend === undefined && arm.orchestration === undefined;
  if (arm.kind === 'vendor-baseline' && !baselineValid) {
    fail('arm_field_conflict', 'vendor-baseline requires vendor_agent only');
  }
}

function validateCoderVariant(arm: ArmDefinition): void {
  const orchestration = arm.orchestration;
  if (!orchestration) return;
  const hasVariant = orchestration.coder_review_variant !== undefined;
  if ((orchestration.mode === 'coder-review') !== hasVariant) {
    fail('coder_review_variant_invalid', 'coder-review mode and variant must be present together');
  }
  if (hasVariant && !['audit-retry', 'reviewer-fix'].includes(
    orchestration.coder_review_variant as string,
  )) {
    fail('coder_review_variant_invalid', 'unknown coder-review variant');
  }
}

function validateAskManager(arm: ArmDefinition): void {
  const orchestration = arm.orchestration;
  if (orchestration?.ask_manager === true && orchestration.mode !== 'manager') {
    fail('ask_manager_unsupported_mode', 'ask_manager requires manager mode');
  }
}

function expectedThreadStarts(arm: ArmDefinition): number {
  const mode = arm.orchestration?.mode;
  return arm.kind === 'cortex' && (mode === 'coder-review' || mode === 'manager') ? 1 : 0;
}

function validateThreadStarts(arm: ArmDefinition): void {
  if (arm.limits.max_thread_starts !== expectedThreadStarts(arm)) {
    fail('arm_field_conflict', 'max_thread_starts is inconsistent with kind and mode');
  }
}

function validateQuestionLimit(arm: ArmDefinition): void {
  if (arm.orchestration?.ask_manager !== true && arm.limits.max_parent_questions !== 0) {
    fail('arm_field_conflict', 'max_parent_questions must be zero when ask_manager is false');
  }
}

function validateTaskLimits(arm: ArmDefinition): void {
  const manager = arm.orchestration?.mode === 'manager';
  if (!manager && (arm.limits.max_task_depth !== 0 || arm.limits.max_tasks !== 0)) {
    fail('arm_field_conflict', 'non-manager modes require zero task depth and task count');
  }
  if (manager && arm.limits.max_tasks < 1) {
    fail('limit_out_of_range', 'manager mode requires at least one task');
  }
}

function validateCapacity(arm: ArmDefinition): void {
  if (arm.limits.max_resident_agent_processes < arm.limits.max_task_depth + 1) {
    fail('capacity_rule_violated', 'resident processes must cover task depth plus answerer');
  }
}

function validatePiBaselineProvider(arm: ArmDefinition): void {
  if (arm.kind === 'vendor-baseline' && arm.vendor_agent === 'pi' && arm.provider === null) {
    fail('arm_field_conflict', 'the pi vendor baseline requires provider');
  }
}

function validateCrossFields(arm: ArmDefinition): void {
  validateKindFields(arm);
  validateCoderVariant(arm);
  validateAskManager(arm);
  validateThreadStarts(arm);
  validateQuestionLimit(arm);
  validateTaskLimits(arm);
  validateCapacity(arm);
}

function schemaFailure(error: unknown): ArmValidationError {
  if (!(error instanceof z.ZodError)) return error as ArmValidationError;
  const issue = error.issues[0];
  const field = issue?.path.join('.') || 'arm';
  return new ArmValidationError('arm_schema_invalid', `${field}: ${issue?.message ?? 'invalid'}`);
}

function parsedArm(value: unknown): ArmDefinition {
  try {
    return armSchema.parse(value) as ArmDefinition;
  } catch (error) {
    throw schemaFailure(error);
  }
}

export function validateArmResolutionShape(value: unknown): void {
  try {
    armResolutionSchema.parse(value);
  } catch (error) {
    throw schemaFailure(error);
  }
}

export function parseArmDefinitionForCompiler(value: unknown): ArmDefinition {
  const arm = parsedArm(value);
  validateLimitRanges(arm.limits);
  validateCrossFields(arm);
  return arm;
}

export function validateArmPostCredential(arm: ArmDefinition): void {
  validatePiBaselineProvider(arm);
}

export function parseArmDefinition(value: unknown): ArmDefinition {
  const arm = parseArmDefinitionForCompiler(value);
  validateArmPostCredential(arm);
  return arm;
}

export function parseArmDefinitionSet(values: unknown[]): ArmDefinition[] {
  const arms = values.map(parseArmDefinition);
  const names = new Set(arms.map(arm => arm.name));
  if (names.size !== arms.length) fail('arm_schema_invalid', 'arm names must be unique');
  return arms;
}
