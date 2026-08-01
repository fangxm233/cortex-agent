// input:  lifecycle values and frozen manifest schemas
// output: terminal manifest types, builder, and validator
// pos:    Value contract for terminal run truth
// >>> If I am updated, update my header and folder CORTEX.md <<<

const MANIFEST_SCHEMA = 'cortex-bench-manifest/1';
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type TerminalState = 'completed' | 'failed' | 'cancelled' | 'timeout';
export type TerminalReason = 'ok' | 'child_failure' | 'deadline' | 'deadline_exceeded' | 'cancelled'
  | 'containment_failure' | 'containment_failed' | 'missing_quiescent'
  | 'trajectory_write_failed' | 'rate_limited' | 'protocol_violation'
  | 'step_limit_exceeded' | 'cost_limit_exceeded';

export interface SupervisorEvidence {
  quiescent: boolean;
  descendants: number;
}

export interface TokenCounts {
  input: number | null;
  output: number | null;
  cache_read?: number | null;
  cache_creation?: number | null;
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
  rootRunId: string;
  threadId: string | null;
  state: TerminalState;
  startedAt: string;
  endedAt: string;
  journalPath: string;
  journalSha256: string;
  eventCount: number;
  supervisor: SupervisorEvidence;
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
  'event_count', 'supervisor', 'steps', 'cost_usd', 'tokens', ...TERMINAL_IDENTITY_KEYS,
  'terminal_reason',
];

const TERMINAL_REASONS: Record<TerminalState, readonly TerminalReason[]> = {
  completed: ['ok'],
  failed: [
    'child_failure', 'trajectory_write_failed', 'containment_failure',
    'rate_limited', 'protocol_violation', 'step_limit_exceeded', 'cost_limit_exceeded',
  ],
  cancelled: ['cancelled'],
  timeout: ['deadline', 'deadline_exceeded'],
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
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'timeout';
}

function isTerminalReason(value: unknown): value is TerminalReason {
  return Object.values(TERMINAL_REASONS).some(reasons => reasons.includes(value as TerminalReason));
}

function validReasonPair(state: unknown, reason: unknown): boolean {
  if (!isTerminalState(state) || !isTerminalReason(reason)) return false;
  return TERMINAL_REASONS[state].includes(reason);
}

function validSupervisorShape(value: unknown): value is SupervisorEvidence {
  if (!isObject(value) || !exactKeys(value, ['quiescent', 'descendants'])) return false;
  return typeof value.quiescent === 'boolean' && isNonNegativeInteger(value.descendants);
}

function validSupervisor(value: unknown, state: unknown): boolean {
  if (!validSupervisorShape(value) || !isTerminalState(state)) return false;
  if (state !== 'completed') return true;
  return value.quiescent && value.descendants === 0;
}

function validTokens(value: unknown): boolean {
  if (!isObject(value)) return false;
  const required = ['input', 'output'];
  const allowed = [...required, 'cache_read', 'cache_creation'];
  if (!required.every(key => Object.hasOwn(value, key))) return false;
  if (!Object.keys(value).every(key => allowed.includes(key))) return false;
  return Object.values(value).every(isNullableNumber);
}

type ManifestRule = [detail: string, check: (record: Record<string, unknown>) => boolean];

const MANIFEST_RULES: ManifestRule[] = [
  ['schema_version', record => record.schema_version === MANIFEST_SCHEMA],
  ['state', record => isTerminalState(record.state)],
  ['started_at', record => isTimestamp(record.started_at)],
  ['ended_at', record => isTimestamp(record.ended_at)],
  ['journal_path', record => typeof record.journal_path === 'string' && record.journal_path.length > 0],
  ['journal_sha256', record => isSha256(record.journal_sha256)],
  ['event_count', record => isNonNegativeInteger(record.event_count)],
  ['supervisor', record => validSupervisor(record.supervisor, record.state)],
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

export function buildTerminalManifest(input: TerminalManifestInput): Record<string, unknown> {
  return {
    schema_version: MANIFEST_SCHEMA,
    state: input.state,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    journal_path: input.journalPath,
    journal_sha256: input.journalSha256,
    event_count: input.eventCount,
    supervisor: input.supervisor,
    steps: input.steps,
    cost_usd: input.costUsd,
    tokens: input.tokens,
    model_execution_identity_hash: input.modelExecutionIdentityHash,
    role_tool_surface_hash: input.roleToolSurfaceHash,
    bundle_manifest_hash: input.bundleManifestHash,
    terminal_reason: input.terminalReason,
  };
}
