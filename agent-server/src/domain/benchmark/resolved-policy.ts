// input:  validated arms, resolved assets, benchmark failures
// output: frozen policy types, failure classes, deadline accessor
// pos:    Authoritative in-memory benchmark policy value object
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { Backend } from '../../agent-adapter/types.js';
import type { IdentityJsonValue } from '../agent-run/identity.js';
import type { ResolvedAgentRunRole } from '../agent-run/run-config.js';
import type { ArmDefinition, ArmLimits } from './arm-schema.js';
import type { BenchmarkBrokerCapability } from './capabilities.js';

const FAILURE_ROWS = [
  [1, 'arm_schema_invalid'],
  [2, 'arm_field_conflict'],
  [3, 'coder_review_variant_invalid'],
  [4, 'ask_manager_unsupported_mode'],
  [5, 'limit_out_of_range'],
  [6, 'deadline_nonpositive'],
  [7, 'capacity_rule_violated'],
  [8, 'credential_capability_unknown'],
  [9, 'credential_capability_unsupported'],
  [10, 'credential_capability_state_insufficient'],
  [11, 'profile_unresolvable'],
  [12, 'profile_has_fallbacks'],
  [13, 'profile_extra_option_unsupported'],
  [14, 'backend_unsupported_for_kind'],
  [15, 'asset_missing'],
  [16, 'asset_unreadable'],
  [17, 'asset_hash_mismatch'],
  [18, 'duplicate_skill_name'],
  [19, 'mcp_composition_invalid'],
  [20, 'template_not_whitelisted'],
  [21, 'image_digest_unpinned'],
  [22, 'policy_freeze_failed'],
  [23, 'policy_reresolution_attempted'],
  [24, 'coordinator_start_failed'],
  [25, 'parent_detached'],
  [26, 'finalization_incomplete'],
  [27, 'sidecar_unauthenticated'],
  [28, 'backend_lacks_long_mcp_call'],
  [29, 'cli_version_unsupported_for_long_mcp_call'],
  [30, 'policy_guard_absent'],
  [31, 'runtime_port_unbound'],
  [32, 'port_scope_escaped'],
  [33, 'capability_denied'],
  [34, 'stale_generation'],
  [35, 'cross_branch_mutation'],
  [36, 'out_of_trial_path'],
  [37, 'proposal_invalidated'],
  [38, 'seal_precondition_unmet'],
  [39, 'attempt_unaccounted'],
  [40, 'composite_manifest_invalid'],
  [41, 'terminal_predicate_unmet'],
  [42, 'ledger_unreadable'],
] as const;

const CLASS_P_CODES = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  24, 28, 29, 30,
]);

export type BenchmarkFailureReason = typeof FAILURE_ROWS[number][1];
export type BenchmarkFailureClass = 'P' | 'R';

export interface BenchmarkFailureSpec {
  code: number;
  reason: BenchmarkFailureReason;
  failureClass: BenchmarkFailureClass;
}

export const BENCHMARK_FAILURES: readonly BenchmarkFailureSpec[] = Object.freeze(
  FAILURE_ROWS.map(([code, reason]) => Object.freeze({
    code,
    reason,
    failureClass: CLASS_P_CODES.has(code) ? 'P' as const : 'R' as const,
  })),
);

export const BENCHMARK_FAILURE_INVARIANTS = Object.freeze({
  P: Object.freeze([
    'nonzero_exit', 'no_partial_policy_or_process_admitted', 'json_reason_stderr',
  ]),
  R: Object.freeze([
    'nonzero_exit', 'strict_finalization', 'json_reason_stderr',
  ]),
});

export interface FailureStderr {
  write(chunk: string): unknown;
}

function failureByReason(reason: BenchmarkFailureReason): BenchmarkFailureSpec {
  const failure = BENCHMARK_FAILURES.find(candidate => candidate.reason === reason);
  if (!failure) throw new Error(`Unknown benchmark failure reason: ${reason}`);
  return failure;
}

export class PolicyCompilationError extends Error {
  readonly code: number;
  readonly failureClass: BenchmarkFailureClass;

  constructor(
    readonly reason: BenchmarkFailureReason,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'PolicyCompilationError';
    const failure = failureByReason(reason);
    this.code = failure.code;
    this.failureClass = failure.failureClass;
  }

  record(): { code: number; failure_class: BenchmarkFailureClass; reason: BenchmarkFailureReason } {
    return { code: this.code, failure_class: this.failureClass, reason: this.reason };
  }
}

export function reportBenchmarkFailure(
  error: PolicyCompilationError,
  stderr: FailureStderr = process.stderr,
): void {
  stderr.write(`${JSON.stringify(error.record())}\n`);
}

export type AssetKind =
  | 'arm'
  | 'credential_capability'
  | 'profile'
  | 'cli_artifact'
  | 'provider_route'
  | 'prompt'
  | 'tool_set'
  | 'plugin_dir'
  | 'skill'
  | 'mcp_server'
  | 'thread_template'
  | 'thread_agent'
  | 'limits';

export interface PolicyAssetInventoryEntry {
  ordinal: number;
  kind: AssetKind;
  logical_name: string;
  resolved_path: string;
  content_sha256: string;
}

export interface ResolvedPolicyModelExecution {
  backend: Backend;
  requested_model: string;
  model_alias_policy: IdentityJsonValue;
  provider_protocol: string | null;
  configured_route_base_host: string | null;
  claude_cli_version: string | null;
  reasoning_effort: string | null;
  fallback_empty: true;
}

export type CredentialCapabilityState =
  | 'unsupported'
  | 'offline-contract-passed'
  | 'live-handshake-passed';

export interface ResolvedTrialPolicy {
  schema_version: 'cortex-benchmark-resolved-policy/2';
  arm: ArmDefinition;
  arm_canonical_sha256: string;
  trial_id: string;
  root_run_id: string;
  task: { task_id: string; image_ref: string; image_digest: string };
  deadline: {
    compiled_at_epoch_ms: number;
    absolute_epoch_ms: number;
    monotonic_origin_ns: number;
  };
  asset_inventory: PolicyAssetInventoryEntry[];
  asset_inventory_sha256: string;
  model_execution: ResolvedPolicyModelExecution;
  roles: Record<string, ResolvedAgentRunRole>;
  identity: {
    model_execution_identity_hash: Record<string, string>;
    role_tool_surface_hash: Record<string, string>;
    bundle_manifest_hash: string;
  };
  child_template_whitelist: string[];
  capability_whitelist: BenchmarkBrokerCapability[];
  credential: {
    capability_key: string;
    capability_state: CredentialCapabilityState;
    upstream_base_url: string;
    route_identity_host: string;
    proxy_base_url: string;
    dummy_token_ref: string;
  };
  limits: ArmLimits;
  derived: { effective_admission_budget: number };
  artifact_inventory_spec: IdentityJsonValue;
}

function cloneArray(value: unknown[], seen: Set<object>): unknown[] {
  return value.map(item => cloneFreezable(item, seen));
}

function cloneRecord(value: object, seen: Set<object>): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) throw new TypeError(`Accessor is not freezable: ${key}`);
    if (descriptor.enumerable) result[key] = cloneFreezable(descriptor.value, seen);
  }
  return result;
}

function cloneScalar(value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('Non-data value is not freezable');
  }
  return value;
}

function assertFreezableContainer(value: object, seen: Set<object>): void {
  if (seen.has(value)) throw new TypeError('Circular policy value');
  const valid = Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
  if (!valid) throw new TypeError('Mutable container is not allowed in policy');
  seen.add(value);
}

function cloneFreezable(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return cloneScalar(value);
  assertFreezableContainer(value, seen);
  const result = Array.isArray(value) ? cloneArray(value, seen) : cloneRecord(value, seen);
  seen.delete(value);
  return result;
}

function freezeValue(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeValue(child);
  Object.freeze(value);
}

export function deepFreezePolicy(policy: ResolvedTrialPolicy): ResolvedTrialPolicy {
  const clone = cloneFreezable(policy, new Set()) as ResolvedTrialPolicy;
  freezeValue(clone);
  return clone;
}

export function remainingDeadlineMs(policy: ResolvedTrialPolicy, nowMs: number): number {
  return Math.max(0, policy.deadline.absolute_epoch_ms - nowMs);
}
