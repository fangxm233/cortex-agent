// input:  lifecycle, journal, usage, and identity values
// output: v2 terminal marker types, builder, and validator
// pos:    Terminal evidence v2 value contract
// >>> If I am updated, update my header and folder CORTEX.md <<<

import path from 'node:path';

export const TERMINAL_MANIFEST_SCHEMA_VERSION = 'cortex-bench-manifest/2';
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type TerminalState = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'aborted';
export type TerminalReason = 'ok' | 'child_failure' | 'deadline' | 'deadline_exceeded' | 'cancelled'
  | 'containment_failure' | 'containment_failed' | 'missing_quiescent'
  | 'trajectory_write_failed' | 'rate_limited' | 'protocol_violation'
  | 'step_limit_exceeded' | 'cost_limit_exceeded' | 'provider_error' | 'aborted';

export interface SupervisorEvidence {
  quiescent: boolean;
  descendants: number;
}

export interface TokenCounts {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_creation: null;
}

export interface StartedMarkerInput {
  trajectoryRoot: string;
  rootRunId: string;
  threadId: string | null;
  journalPath: string;
  now?: () => Date;
}

export interface TerminalManifestInput {
  trajectoryRoot: string;
  /** The pinned launcher already resolved this root and created its private subtree. */
  canonicalTrajectoryRoot?: true;
  rootRunId: string;
  threadId: string | null;
  state: TerminalState;
  startedAt: string;
  endedAt: string;
  journalPath: string;
  journalSha256: string;
  eventCount: number;
  steps: number | null;
  costUsd: number | null;
  tokens: TokenCounts;
  modelExecutionIdentityHash: string;
  roleToolSurfaceHash: string;
  bundleManifestHash: string;
  terminalReason: TerminalReason;
}

export const TERMINAL_IDENTITY_KEYS = [
  'model_execution_identity_hash', 'role_tool_surface_hash', 'bundle_manifest_hash',
] as const;

const TERMINAL_KEYS = [
  'schema_version', 'state', 'started_at', 'ended_at', 'journal_path', 'journal_sha256',
  'event_count', 'steps', 'cost_usd', 'tokens', ...TERMINAL_IDENTITY_KEYS,
  'terminal_reason',
];

const TERMINAL_REASONS: Record<TerminalState, readonly TerminalReason[]> = {
  completed: ['ok'],
  failed: [
    'child_failure', 'trajectory_write_failed', 'containment_failure',
    'rate_limited', 'protocol_violation', 'step_limit_exceeded', 'cost_limit_exceeded',
    'provider_error',
  ],
  cancelled: ['cancelled'],
  timeout: ['deadline', 'deadline_exceeded'],
  aborted: ['aborted'],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, required: readonly string[]): boolean {
  const allowed = new Set(required);
  return required.every(key => Object.hasOwn(record, key))
    && Object.keys(record).every(key => allowed.has(key));
}

function isTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isTerminalState(value: unknown): value is TerminalState {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
    || value === 'timeout' || value === 'aborted';
}

function isTerminalReason(value: unknown): value is TerminalReason {
  return Object.values(TERMINAL_REASONS).some(reasons => reasons.includes(value as TerminalReason));
}

function validReasonPair(state: unknown, reason: unknown): boolean {
  if (!isTerminalState(state) || !isTerminalReason(reason)) return false;
  return TERMINAL_REASONS[state].includes(reason);
}

function validTokens(value: unknown): boolean {
  if (!isObject(value)) return false;
  const required = ['input', 'output', 'cache_read', 'cache_creation'];
  return exactKeys(value, required)
    && isNullableNumber(value.input) && isNullableNumber(value.output)
    && isNullableNumber(value.cache_read) && value.cache_creation === null;
}

type ManifestRule = [detail: string, check: (record: Record<string, unknown>) => boolean];

const MANIFEST_RULES: ManifestRule[] = [
  ['schema_version', record => record.schema_version === TERMINAL_MANIFEST_SCHEMA_VERSION],
  ['state', record => isTerminalState(record.state)],
  ['started_at', record => isTimestamp(record.started_at)],
  ['ended_at', record => isTimestamp(record.ended_at)],
  ['journal_path', record => typeof record.journal_path === 'string' && record.journal_path.length > 0],
  ['journal_sha256', record => isSha256(record.journal_sha256)],
  ['event_count', record => isNonNegativeInteger(record.event_count)],
  ['steps', record => isNullableNumber(record.steps)],
  ['cost_usd', record => isNullableNumber(record.cost_usd)],
  ['tokens', record => validTokens(record.tokens)],
  ['model_execution_identity_hash', record => isSha256(record.model_execution_identity_hash)],
  ['role_tool_surface_hash', record => isSha256(record.role_tool_surface_hash)],
  ['bundle_manifest_hash', record => isSha256(record.bundle_manifest_hash)],
  ['terminal_reason', record => validReasonPair(record.state, record.terminal_reason)],
];

export function terminalManifestProblem(value: unknown): string | null {
  if (!isObject(value) || !exactKeys(value, TERMINAL_KEYS)) return 'envelope';
  return MANIFEST_RULES.find(([, check]) => !check(value))?.[0] ?? null;
}

export function recordedJournalPath(trajectoryRoot: string, journalPath: string): string {
  const root = path.resolve(trajectoryRoot);
  return path.relative(root, path.resolve(root, journalPath));
}

export function buildTerminalManifest(input: TerminalManifestInput): Record<string, unknown> {
  return {
    schema_version: TERMINAL_MANIFEST_SCHEMA_VERSION,
    state: input.state,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    journal_path: recordedJournalPath(input.trajectoryRoot, input.journalPath),
    journal_sha256: input.journalSha256,
    event_count: input.eventCount,
    steps: input.steps,
    cost_usd: input.costUsd,
    tokens: input.tokens,
    model_execution_identity_hash: input.modelExecutionIdentityHash,
    role_tool_surface_hash: input.roleToolSurfaceHash,
    bundle_manifest_hash: input.bundleManifestHash,
    terminal_reason: input.terminalReason,
  };
}
