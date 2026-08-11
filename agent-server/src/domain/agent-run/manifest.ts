// input:  canonical roots, lifecycle metadata and admission journals
// output: relocatable lifecycle files and state-gated validation
// pos:    Lifecycle truth and validator for one-shot agent runs
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash, type Hash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  TrajectoryWriteFailedError, type StateAdmissionEvidence,
} from './journal.js';
import {
  buildTerminalManifest, recordedJournalPath, terminalManifestProblem, TERMINAL_IDENTITY_KEYS,
  type StartedMarkerInput, type TerminalManifestInput,
} from './manifest-contract.js';
export type {
  StartedMarkerInput, SupervisorEvidence, TerminalManifestInput,
  TerminalReason, TerminalState, TokenCounts,
} from './manifest-contract.js';

const JOURNAL_SCHEMA = 'cortex-bench-journal/1';
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const READ_BUFFER_BYTES = 64 * 1024;

export interface JournalHeaderRecord {
  rootRunId: string;
  threadId: string | null;
  agentSlot: string;
  modelExecutionIdentityHash: string;
  roleToolSurfaceHash: string;
  bundleManifestHash: string;
}

export interface JournalRoleIdentity {
  roleToolSurfaceHash: string;
  bundleManifestHash: string;
}

interface JournalModelObservation {
  requestedModel: string;
  provider: string | null;
}

interface JournalScanState {
  pending: string;
  lineNumber: number;
  eventCount: number;
  header: JournalHeaderRecord | null;
  stateAdmission: StateAdmissionEvidence | null;
  modelObservation: JournalModelObservation | null;
  roleIdentities: Map<string, JournalRoleIdentity>;
  expectedRoleIdentities?: ReadonlyMap<string, JournalRoleIdentity>;
  problems: string[];
  hash: Hash;
}

interface JournalScanResult {
  sha256: string | null;
  eventCount: number;
  header: JournalHeaderRecord | null;
  stateAdmission: StateAdmissionEvidence | null;
  modelObservation: JournalModelObservation | null;
  problems: string[];
}

interface EventSchema {
  required: Record<string, FieldRule>;
  optional?: Record<string, FieldRule>;
}

type FieldRule = (value: unknown) => boolean;
type JsonReadResult = { ok: true; value: unknown } | { ok: false };
type LineParseResult = { ok: true; value: unknown } | { ok: false; detail: string };

class FilesystemOperationError extends Error {
  constructor(readonly operation: string, cause: unknown) {
    super(`${operation} failed`, { cause });
    this.name = 'FilesystemOperationError';
  }
}

const HEADER_KEYS = [
  'schema_version', 'type', 'root_run_id', 'thread_id', 'agent_slot', 'seq', 'ts',
  'resolved_cwd', 'canonical_instruction_sha256', 'model_visible_prompt_sha256',
  'system_prompt_sha256', 'tool_manifest_sha256', 'plugin_manifest_sha256',
  'model_execution_identity_hash', 'role_tool_surface_hash', 'bundle_manifest_hash',
];

const EVENT_KEYS = [
  'schema_version', 'type', 'root_run_id', 'thread_id', 'step', 'agent_slot', 'seq', 'ts',
  'backend', 'provider', 'requested_model', 'reported_model',
  'model_execution_identity_hash', 'role_tool_surface_hash', 'bundle_manifest_hash', 'event',
];

const STATE_ADMISSION_KEYS = [
  'schema_version', 'type', 'root_run_id', 'thread_id', 'agent_slot', 'seq', 'ts',
  'model_execution_identity_hash', 'role_tool_surface_hash', 'bundle_manifest_hash', 'evidence',
];

const STATE_ROOT_KEYS = [
  'project', 'task', 'thread', 'session', 'execution', 'cache', 'temp', 'backend',
];

const HEADER_HASH_KEYS = [
  'canonical_instruction_sha256', 'model_visible_prompt_sha256', 'system_prompt_sha256',
  'tool_manifest_sha256', 'plugin_manifest_sha256', 'model_execution_identity_hash',
  'role_tool_surface_hash', 'bundle_manifest_hash',
];

const EVENT_HASH_KEYS = [
  'model_execution_identity_hash', 'role_tool_surface_hash', 'bundle_manifest_hash',
];

const isAny: FieldRule = () => true;
const isString: FieldRule = value => typeof value === 'string';
const isBoolean: FieldRule = value => typeof value === 'boolean';
const isNumber: FieldRule = value => typeof value === 'number' && Number.isFinite(value);
const isNullableNumber: FieldRule = value => value === null || isNumber(value);
const isNullableString: FieldRule = value => value === null || isString(value);
const isStringArray: FieldRule = value => Array.isArray(value) && value.every(isString);

function all(checks: boolean[]): boolean {
  return checks.every(Boolean);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isQuestion(value: unknown): boolean {
  if (!isObject(value)) return false;
  return all([
    exactKeys(value, ['question'], ['multi', 'options']),
    isString(value.question),
    value.multi === undefined || isBoolean(value.multi),
    value.options === undefined || isStringArray(value.options),
  ]);
}

const isQuestionArray: FieldRule = value => Array.isArray(value) && value.every(isQuestion);
const isAccuracy: FieldRule = value => value === 'exact' || value === 'estimate';
const isSubagentKind: FieldRule = value => value === 'assistant' || value === 'tool_result';

const EVENT_SCHEMAS: Record<string, EventSchema> = {
  session_started: {
    required: { sessionId: isString }, optional: { sessionFile: isString },
  },
  assistant_text: {
    required: { text: isString }, optional: { blockId: isString, model: isNullableString },
  },
  assistant_delta: {
    required: { text: isString, blockId: isString },
  },
  tool_use: {
    required: { toolUseId: isString, name: isString, input: isAny },
  },
  tool_result: {
    required: { toolUseId: isString, ok: isBoolean, content: isString },
  },
  ask_user_question: {
    required: { toolUseId: isString, questions: isQuestionArray },
  },
  plan_mode_entered: {
    required: { toolUseId: isString, planFilePath: isString },
  },
  plan_written: {
    required: { toolUseId: isString, path: isString, content: isString },
  },
  context_compacted: {
    required: { trigger: isString }, optional: { preTokens: isNumber },
  },
  context_usage: {
    required: {
      usedTokens: isNullableNumber, contextWindow: isNumber,
      percent: isNullableNumber, accuracy: isAccuracy,
    },
  },
  rate_limit: {
    required: { raw: isAny },
  },
  cost_record: {
    required: {
      provider: isString, model: isString, tokens_in: isNullableNumber,
      tokens_out: isNullableNumber, cost_usd: isNullableNumber,
    },
    optional: {
      prompt_tokens: isNullableNumber, cached_tokens: isNullableNumber,
    },
  },
  turn_progress: {
    required: { numTurns: isNumber },
  },
  turn_complete: {
    required: { numTurns: isNullableNumber, totalCostUsd: isNullableNumber },
    optional: { error: isNullableString },
  },
  // §17 G4-SA6. Journal validation is a closed whitelist (`validNormalizedEvent`), so a union
  // member without a row here makes every journal that carries it a malformed fragment.
  subagent_activity: {
    required: {
      parentToolUseId: isString, subagentType: isNullableString, kind: isSubagentKind,
    },
  },
  error: {
    required: { message: isString, fatal: isBoolean },
  },
};

function operationFailure(operation: string, cause: unknown): FilesystemOperationError {
  return new FilesystemOperationError(operation, cause);
}

function trajectoryFailure(context: string, failures: unknown[]): TrajectoryWriteFailedError {
  const cause = failures.length === 1 ? failures[0] : new AggregateError(failures);
  return new TrajectoryWriteFailedError(`${context}: trajectory write failed`, { cause });
}

function serializeLine(value: unknown): Buffer {
  try {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  } catch (error) {
    throw operationFailure('serialize', error);
  }
}

function writeSlice(fd: number, data: Buffer, offset: number): number {
  try {
    return fs.writeSync(fd, data, offset, data.length - offset);
  } catch (error) {
    throw operationFailure('write', error);
  }
}

function writeFull(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSlice(fd, data, offset);
    if (written <= 0) throw operationFailure('write', new Error('zero-byte write'));
    offset += written;
  }
}

function fsyncFd(fd: number): FilesystemOperationError | null {
  try {
    fs.fsyncSync(fd);
    return null;
  } catch (error) {
    return operationFailure('fsync', error);
  }
}

function closeFd(fd: number): FilesystemOperationError | null {
  try {
    fs.closeSync(fd);
    return null;
  } catch (error) {
    return operationFailure('close', error);
  }
}

function appendFailure(failures: unknown[], failure: unknown | null): void {
  if (failure) failures.push(failure);
}

function isoTimestamp(now: () => Date): string {
  try {
    return now().toISOString();
  } catch (error) {
    throw operationFailure('timestamp', error);
  }
}

const LIFECYCLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertPathIdentifier(value: string): void {
  if (LIFECYCLE_ID_PATTERN.test(value)) return;
  throw trajectoryFailure('lifecycle path', [new Error('id must match the lifecycle identifier grammar')]);
}

function lifecycleStem(rootRunId: string, threadId: string | null): string {
  const id = threadId ?? rootRunId;
  assertPathIdentifier(id);
  return `${threadId === null ? 'run' : 'thread'}-${id}`;
}

function lifecyclePath(
  trajectoryRoot: string,
  rootRunId: string,
  threadId: string | null,
  suffix: 'started' | 'terminal',
): string {
  return path.join(trajectoryRoot, `${lifecycleStem(rootRunId, threadId)}.${suffix}.json`);
}

export function resolveLifecyclePaths(input: {
  trajectoryRoot: string;
  rootRunId: string;
  threadId: string | null;
}): { started: string; terminal: string } {
  return {
    started: lifecyclePath(input.trajectoryRoot, input.rootRunId, input.threadId, 'started'),
    terminal: lifecyclePath(input.trajectoryRoot, input.rootRunId, input.threadId, 'terminal'),
  };
}

function temporaryPath(finalPath: string): string {
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return `${finalPath}.tmp.${nonce}`;
}

function openTemporary(filePath: string): number {
  try {
    return fs.openSync(filePath, 'wx', 0o600);
  } catch (error) {
    throw operationFailure('open', error);
  }
}

function writeDurableTemporary(filePath: string, data: Buffer): void {
  let fd: number;
  try {
    fd = openTemporary(filePath);
  } catch (error) {
    throw trajectoryFailure('temporary file', [error]);
  }
  const failures: unknown[] = [];
  try {
    writeFull(fd, data);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 0) appendFailure(failures, fsyncFd(fd));
  appendFailure(failures, closeFd(fd));
  if (failures.length > 0) throw trajectoryFailure('temporary file', failures);
}

function unlinkTemporary(filePath: string): FilesystemOperationError | null {
  try {
    fs.unlinkSync(filePath);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return operationFailure('unlink', error);
  }
}

function linkTemporary(temporary: string, finalPath: string): void {
  try {
    fs.linkSync(temporary, finalPath);
  } catch (error) {
    throw operationFailure('link', error);
  }
}

function renameTemporary(temporary: string, finalPath: string): void {
  try {
    fs.renameSync(temporary, finalPath);
  } catch (error) {
    throw operationFailure('rename', error);
  }
}

function writeAndPublish(
  finalPath: string,
  record: Record<string, unknown>,
  publish: (temporary: string, finalPath: string) => void,
): void {
  const temporary = temporaryPath(finalPath);
  const failures: unknown[] = [];
  try {
    writeDurableTemporary(temporary, serializeLine(record));
    publish(temporary, finalPath);
  } catch (error) {
    failures.push(error);
  }
  appendFailure(failures, unlinkTemporary(temporary));
  if (failures.length > 0) throw trajectoryFailure('lifecycle publish', failures);
}

function startedMarker(input: StartedMarkerInput): Record<string, unknown> {
  return {
    root_run_id: input.rootRunId,
    thread_id: input.threadId,
    ts: isoTimestamp(input.now ?? (() => new Date())),
    journal_path: recordedJournalPath(input.trajectoryRoot, input.journalPath),
  };
}

function withTrajectoryFailure<T>(context: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof TrajectoryWriteFailedError) throw error;
    throw trajectoryFailure(context, [error]);
  }
}

export function writeStartedMarker(input: StartedMarkerInput): string {
  return withTrajectoryFailure('started marker', () => {
    const finalPath = lifecyclePath(input.trajectoryRoot, input.rootRunId, input.threadId, 'started');
    writeAndPublish(finalPath, startedMarker(input), linkTemporary);
    return finalPath;
  });
}

function flushJournal(filePath: string): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (error) {
    throw operationFailure('open', error);
  }
  const failures: unknown[] = [];
  appendFailure(failures, fsyncFd(fd));
  appendFailure(failures, closeFd(fd));
  if (failures.length > 0) throw trajectoryFailure('journal flush', failures);
}

function sameStateAdmission(
  observed: StateAdmissionEvidence | null,
  expected: StateAdmissionEvidence | undefined,
): boolean {
  if (!expected) return true;
  if (!observed || observed.schema_version !== expected.schema_version
      || observed.empty_before_projection !== expected.empty_before_projection) return false;
  return STATE_ROOT_KEYS.every(key => (
    observed.roots[key as keyof StateAdmissionEvidence['roots']]
      === expected.roots[key as keyof StateAdmissionEvidence['roots']]
  ));
}

function journalLinkageProblem(
  input: TerminalManifestInput,
  scan: JournalScanResult,
  expectedStateAdmission?: StateAdmissionEvidence,
): string | null {
  const header = scan.header;
  const checks: Array<[boolean, string]> = [
    [scan.problems.length === 0, scan.problems[0] ?? 'malformed_journal'],
    [scan.sha256 === input.journalSha256, 'journal_sha256'],
    [scan.eventCount === input.eventCount, 'event_count'],
    [header !== null, 'missing_header'],
    [header?.rootRunId === input.rootRunId, 'root_run_id'],
    [header?.threadId === input.threadId, 'thread_id'],
    [header?.modelExecutionIdentityHash === input.modelExecutionIdentityHash, 'model_execution_identity_hash'],
    [header?.roleToolSurfaceHash === input.roleToolSurfaceHash, 'role_tool_surface_hash'],
    [header?.bundleManifestHash === input.bundleManifestHash, 'bundle_manifest_hash'],
    [sameStateAdmission(scan.stateAdmission, expectedStateAdmission), 'state_admission'],
  ];
  return checks.find(([passes]) => !passes)?.[1] ?? null;
}

export interface TerminalManifestValidationOptions {
  roleIdentities?: ReadonlyMap<string, JournalRoleIdentity>;
  stateAdmission?: StateAdmissionEvidence;
}

function assertManifestLinkage(
  input: TerminalManifestInput,
  options: TerminalManifestValidationOptions,
): void {
  const journalPath = confinedJournalPath(
    input.trajectoryRoot,
    input.journalPath,
    input.canonicalTrajectoryRoot === true,
  );
  if (!journalPath) throw trajectoryFailure('terminal linkage', [new Error('journal_outside_root')]);
  flushJournal(journalPath);
  const scan = scanJournal(journalPath, options.roleIdentities);
  const problem = journalLinkageProblem(input, scan, options.stateAdmission);
  if (problem) throw trajectoryFailure('terminal linkage', [new Error(problem)]);
}

export function writeTerminalManifest(
  input: TerminalManifestInput,
  options: TerminalManifestValidationOptions = {},
): string {
  return withTrajectoryFailure('terminal manifest', () => {
    const finalPath = lifecyclePath(input.trajectoryRoot, input.rootRunId, input.threadId, 'terminal');
    const record = buildTerminalManifest(input);
    const problem = terminalManifestProblem(record);
    if (problem) throw trajectoryFailure('terminal manifest', [new Error(problem)]);
    assertManifestLinkage(input, options);
    writeAndPublish(finalPath, record, renameTemporary);
    return finalPath;
  });
}

function exactKeys(
  record: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(record, key))
    && Object.keys(record).every(key => allowed.has(key));
}

function isNullableInteger(value: unknown): boolean {
  return value === null || Number.isInteger(value);
}

function isAgentSlot(value: unknown): boolean {
  return value === 'parent' || value === 'benchmark-coder' || value === 'benchmark-reviewer'
    || value === 'benchmark-fixer';
}

function isBackend(value: unknown): boolean {
  return value === 'claude' || value === 'pi';
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

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function hasValidFields(
  record: Record<string, unknown>,
  fields: Record<string, FieldRule>,
): boolean {
  return Object.entries(fields).every(([key, rule]) => rule(record[key]));
}

function hasValidOptionalFields(
  record: Record<string, unknown>,
  fields: Record<string, FieldRule>,
): boolean {
  return Object.entries(fields).every(([key, rule]) => !Object.hasOwn(record, key) || rule(record[key]));
}

function validNormalizedEvent(value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== 'string') return false;
  const schema = EVENT_SCHEMAS[value.type];
  if (!schema) return false;
  const required = ['type', ...Object.keys(schema.required)];
  const optional = Object.keys(schema.optional ?? {});
  return all([
    exactKeys(value, required, optional),
    hasValidFields(value, schema.required),
    hasValidOptionalFields(value, schema.optional ?? {}),
  ]);
}

function validHeaderRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  return all([
    exactKeys(value, HEADER_KEYS),
    value.schema_version === JOURNAL_SCHEMA,
    value.type === 'run_header',
    value.seq === 0,
    typeof value.root_run_id === 'string' && value.root_run_id.length > 0,
    isNullableString(value.thread_id),
    isAgentSlot(value.agent_slot),
    isTimestamp(value.ts),
    typeof value.resolved_cwd === 'string' && path.isAbsolute(value.resolved_cwd),
    HEADER_HASH_KEYS.every(key => isSha256(value[key])),
  ]);
}

function headerRecord(value: Record<string, unknown>): JournalHeaderRecord {
  return {
    rootRunId: String(value.root_run_id),
    threadId: value.thread_id as string | null,
    agentSlot: String(value.agent_slot),
    modelExecutionIdentityHash: String(value.model_execution_identity_hash),
    roleToolSurfaceHash: String(value.role_tool_surface_hash),
    bundleManifestHash: String(value.bundle_manifest_hash),
  };
}

function confinedRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

function validStateAdmissionEvidence(value: unknown): value is StateAdmissionEvidence {
  if (!isObject(value) || !exactKeys(value, [
    'schema_version', 'empty_before_projection', 'roots',
  ]) || !isObject(value.roots) || !exactKeys(value.roots, STATE_ROOT_KEYS)) return false;
  return value.schema_version === 'cortex-standalone-state-admission/1'
    && value.empty_before_projection === true
    && STATE_ROOT_KEYS.every(key => confinedRelativePath(value.roots[key]));
}

function validStateAdmissionRecord(
  value: unknown,
  header: JournalHeaderRecord | null,
): value is Record<string, unknown> {
  if (!isObject(value) || !header) return false;
  return all([
    exactKeys(value, STATE_ADMISSION_KEYS),
    value.schema_version === JOURNAL_SCHEMA,
    value.type === 'state_admission',
    value.seq === 1,
    value.root_run_id === header.rootRunId,
    value.thread_id === null && header.threadId === null,
    value.agent_slot === 'parent' && header.agentSlot === 'parent',
    isTimestamp(value.ts),
    value.model_execution_identity_hash === header.modelExecutionIdentityHash,
    value.role_tool_surface_hash === header.roleToolSurfaceHash,
    value.bundle_manifest_hash === header.bundleManifestHash,
    validStateAdmissionEvidence(value.evidence),
  ]);
}

function validEventRecord(
  value: unknown,
  expectedSeq: number,
  header: JournalHeaderRecord | null,
): boolean {
  if (!isObject(value)) return false;
  if (!header) return false;
  return all([
    exactKeys(value, EVENT_KEYS),
    value.schema_version === JOURNAL_SCHEMA,
    value.type === 'event',
    value.seq === expectedSeq,
    value.root_run_id === header.rootRunId,
    value.thread_id === header.threadId,
    isNullableInteger(value.step),
    isAgentSlot(value.agent_slot),
    isTimestamp(value.ts),
    isBackend(value.backend),
    isNullableString(value.provider),
    isNonEmptyString(value.requested_model),
    isNullableString(value.reported_model),
    EVENT_HASH_KEYS.every(key => isSha256(value[key])),
    value.model_execution_identity_hash === header.modelExecutionIdentityHash,
    validNormalizedEvent(value.event),
  ]);
}

function malformedRecord(filePath: string, line: number, detail: string): string {
  return `malformed_record:${filePath}:${line}:${detail}`;
}

function parseJournalLine(line: string): LineParseResult {
  if (line.length === 0) return { ok: false, detail: 'blank_line' };
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false, detail: 'invalid_json' };
  }
}

function matchesExpectedRole(
  state: JournalScanState,
  slot: string,
  observed: JournalRoleIdentity,
): boolean {
  if (!state.expectedRoleIdentities) return true;
  const expected = state.expectedRoleIdentities.get(slot);
  return !!expected && expected.roleToolSurfaceHash === observed.roleToolSurfaceHash
    && expected.bundleManifestHash === observed.bundleManifestHash;
}

function validateHeaderLine(state: JournalScanState, filePath: string, value: unknown): void {
  if (validHeaderRecord(value)) {
    state.header = headerRecord(value);
    const observed = {
      roleToolSurfaceHash: state.header.roleToolSurfaceHash,
      bundleManifestHash: state.header.bundleManifestHash,
    };
    state.roleIdentities.set(state.header.agentSlot, observed);
    if (matchesExpectedRole(state, state.header.agentSlot, observed)) return;
  }
  state.problems.push(malformedRecord(filePath, state.lineNumber, 'invalid_envelope'));
}

function trackModelObservation(state: JournalScanState, value: Record<string, unknown>): boolean {
  const observed = {
    requestedModel: String(value.requested_model), provider: value.provider as string | null,
  };
  if (!state.modelObservation) {
    state.modelObservation = observed;
    return true;
  }
  return state.modelObservation.requestedModel === observed.requestedModel
    && state.modelObservation.provider === observed.provider;
}

function trackRoleIdentity(state: JournalScanState, value: Record<string, unknown>): boolean {
  const slot = String(value.agent_slot);
  const observed = {
    roleToolSurfaceHash: String(value.role_tool_surface_hash),
    bundleManifestHash: String(value.bundle_manifest_hash),
  };
  if (!matchesExpectedRole(state, slot, observed)) return false;
  const expected = state.roleIdentities.get(slot);
  if (!expected) {
    // Distinctness is asked of the role hash only. A compiled trial policy carries one
    // `bundle_manifest_hash` for the whole arm, so every slot of a policy-backed run legitimately
    // presents the same one (design section 16 (16.2) ID2); and a slot that presents another slot's
    // whole identity still shares its role hash, which this clause catches on its own.
    const reused = [...state.roleIdentities.values()].some(identity => (
      identity.roleToolSurfaceHash === observed.roleToolSurfaceHash
    ));
    if (reused) return false;
    state.roleIdentities.set(slot, observed);
    return true;
  }
  return expected.roleToolSurfaceHash === observed.roleToolSurfaceHash
    && expected.bundleManifestHash === observed.bundleManifestHash;
}

function validateStateAdmissionLine(
  state: JournalScanState, filePath: string, value: unknown,
): void {
  if (state.lineNumber === 2 && state.stateAdmission === null
      && validStateAdmissionRecord(value, state.header)) {
    state.stateAdmission = (value as Record<string, unknown>).evidence as StateAdmissionEvidence;
    return;
  }
  state.problems.push(malformedRecord(filePath, state.lineNumber, 'invalid_state_admission'));
}

function validateEventLine(state: JournalScanState, filePath: string, value: unknown): void {
  state.eventCount += 1;
  const valid = validEventRecord(value, state.lineNumber - 1, state.header);
  if (valid && trackModelObservation(state, value as Record<string, unknown>)
    && trackRoleIdentity(state, value as Record<string, unknown>)) return;
  state.problems.push(malformedRecord(filePath, state.lineNumber, 'invalid_envelope'));
}

function validateJournalLine(state: JournalScanState, filePath: string, line: string): void {
  state.lineNumber += 1;
  const parsed = parseJournalLine(line);
  if (parsed.ok === false) {
    state.problems.push(malformedRecord(filePath, state.lineNumber, parsed.detail));
    return;
  }
  if (state.lineNumber === 1) validateHeaderLine(state, filePath, parsed.value);
  else if (isObject(parsed.value) && parsed.value.type === 'state_admission') {
    validateStateAdmissionLine(state, filePath, parsed.value);
  } else validateEventLine(state, filePath, parsed.value);
}

function consumeDecoded(state: JournalScanState, filePath: string, text: string): void {
  state.pending += text;
  while (true) {
    const newline = state.pending.indexOf('\n');
    if (newline < 0) return;
    const line = state.pending.slice(0, newline);
    state.pending = state.pending.slice(newline + 1);
    validateJournalLine(state, filePath, line);
  }
}

function newScanState(
  expectedRoleIdentities?: ReadonlyMap<string, JournalRoleIdentity>,
): JournalScanState {
  return {
    pending: '', lineNumber: 0, eventCount: 0, header: null, stateAdmission: null,
    modelObservation: null, roleIdentities: new Map(), expectedRoleIdentities,
    problems: [], hash: createHash('sha256'),
  };
}

function finishScan(state: JournalScanState, filePath: string): JournalScanResult {
  if (state.pending.length > 0) {
    state.problems.push(malformedRecord(filePath, state.lineNumber + 1, 'incomplete_line'));
  }
  if (state.lineNumber === 0) state.problems.push(malformedRecord(filePath, 1, 'missing_header'));
  return {
    sha256: state.hash.digest('hex'), eventCount: state.eventCount,
    header: state.header, stateAdmission: state.stateAdmission,
    modelObservation: state.modelObservation, problems: state.problems,
  };
}

function scanFileDescriptor(
  fd: number,
  filePath: string,
  expectedRoleIdentities?: ReadonlyMap<string, JournalRoleIdentity>,
): JournalScanResult {
  const state = newScanState(expectedRoleIdentities);
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const decoder = new StringDecoder('utf8');
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    state.hash.update(chunk);
    consumeDecoded(state, filePath, decoder.write(chunk));
  }
  consumeDecoded(state, filePath, decoder.end());
  return finishScan(state, filePath);
}

function scanJournal(
  filePath: string,
  expectedRoleIdentities?: ReadonlyMap<string, JournalRoleIdentity>,
): JournalScanResult {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return unreadableScan(filePath, 'open');
  }
  let result: JournalScanResult;
  try {
    result = scanFileDescriptor(fd, filePath, expectedRoleIdentities);
  } catch {
    result = unreadableScan(filePath, 'read');
  }
  if (closeFd(fd)) result.problems.push(`journal_unreadable:${filePath}:close`);
  return result;
}

function unreadableScan(filePath: string, operation: string): JournalScanResult {
  return {
    sha256: null, eventCount: 0, header: null, stateAdmission: null, modelObservation: null,
    problems: [`journal_unreadable:${filePath}:${operation}`],
  };
}

function readJson(filePath: string): JsonReadResult {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

function startedMarkerProblem(value: unknown, filePath: string): string | null {
  const keys = ['root_run_id', 'thread_id', 'ts', 'journal_path'];
  if (!isObject(value) || !exactKeys(value, keys)) return 'envelope';
  const fieldChecks: Array<[boolean, string]> = [
    [isNonEmptyString(value.root_run_id), 'root_run_id'],
    [isNullableString(value.thread_id), 'thread_id'],
    [isTimestamp(value.ts), 'ts'],
    [isNonEmptyString(value.journal_path), 'journal_path'],
  ];
  const fieldProblem = fieldChecks.find(([passes]) => !passes)?.[1];
  if (fieldProblem) return fieldProblem;
  const idField = value.thread_id === null ? 'root_run_id' : 'thread_id';
  const id = String(value[idField]);
  if (!LIFECYCLE_ID_PATTERN.test(id)) return idField;
  const expected = `${value.thread_id === null ? 'run' : 'thread'}-${id}.started.json`;
  return path.basename(filePath) === expected ? null : 'filename';
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function hasSymlinkBelowRoot(root: string, candidate: string): boolean {
  const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function confinedJournalPath(
  root: string,
  candidate: string,
  canonicalRoot = false,
): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(root, candidate);
  if (!isWithin(resolvedRoot, resolvedCandidate)) return null;
  if (canonicalRoot) {
    return hasSymlinkBelowRoot(resolvedRoot, resolvedCandidate) ? null : resolvedCandidate;
  }
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realCandidate = fs.realpathSync(resolvedCandidate);
    return isWithin(realRoot, realCandidate) ? realCandidate : null;
  } catch {
    return resolvedCandidate;
  }
}

function readTerminalManifest(
  filePath: string,
): { record: Record<string, unknown> | null; problem: string | null } {
  const result = readJson(filePath);
  if (!result.ok) return { record: null, problem: 'invalid_json' };
  const problem = terminalManifestProblem(result.value);
  if (problem || !isObject(result.value)) return { record: null, problem };
  return { record: result.value, problem: null };
}

function validateTerminal(
  terminalPath: string,
  marker: Record<string, unknown>,
  problems: string[],
): Record<string, unknown> | null {
  if (!fs.existsSync(terminalPath)) {
    problems.push(`started_without_terminal:${terminalPath}`);
    return null;
  }
  const terminal = readTerminalManifest(terminalPath);
  if (!terminal.record) {
    problems.push(`malformed_terminal_manifest:${terminalPath}:${terminal.problem}`);
    return null;
  }
  if (terminal.record.journal_path === marker.journal_path) return terminal.record;
  problems.push(`malformed_terminal_manifest:${terminalPath}:journal_path`);
  return null;
}

function validateScan(
  scan: JournalScanResult,
  terminal: Record<string, unknown>,
  journalPath: string,
  problems: string[],
  expectedStateAdmission?: StateAdmissionEvidence,
): void {
  problems.push(...scan.problems);
  if (scan.sha256 !== terminal.journal_sha256) {
    problems.push(`journal_hash_mismatch:${journalPath}`);
  }
  if (scan.eventCount !== terminal.event_count) {
    problems.push(`event_count_mismatch:${journalPath}`);
  }
  if (!sameStateAdmission(scan.stateAdmission, expectedStateAdmission)) {
    problems.push(`state_admission_mismatch:${journalPath}`);
  }
}

function validateMarkerIdentity(
  marker: Record<string, unknown>,
  header: JournalHeaderRecord | null,
  journalPath: string,
  problems: string[],
): void {
  if (!header) return;
  const matches = header.rootRunId === marker.root_run_id && header.threadId === marker.thread_id;
  if (!matches) problems.push(`journal_identity_mismatch:${journalPath}`);
}

function headerIdentity(header: JournalHeaderRecord, key: string): string {
  const values: Record<string, string> = {
    model_execution_identity_hash: header.modelExecutionIdentityHash,
    role_tool_surface_hash: header.roleToolSurfaceHash,
    bundle_manifest_hash: header.bundleManifestHash,
  };
  return values[key];
}

function validateTerminalIdentities(
  terminal: Record<string, unknown>,
  header: JournalHeaderRecord | null,
  journalPath: string,
  problems: string[],
): void {
  if (!header) return;
  for (const key of TERMINAL_IDENTITY_KEYS) {
    if (terminal[key] !== headerIdentity(header, key)) {
      problems.push(`terminal_identity_mismatch:${journalPath}:${key}`);
    }
  }
}

function readStartedMarker(
  filePath: string,
): { record: Record<string, unknown> | null; problem: string | null } {
  const result = readJson(filePath);
  if (!result.ok) return { record: null, problem: 'invalid_json' };
  const problem = startedMarkerProblem(result.value, filePath);
  if (problem || !isObject(result.value)) return { record: null, problem };
  return { record: result.value, problem: null };
}

function validateStarted(
  root: string,
  startedPath: string,
  problems: string[],
  expectedRoleIdentities?: ReadonlyMap<string, JournalRoleIdentity>,
  canonicalRoot = false,
  expectedStateAdmission?: StateAdmissionEvidence,
): void {
  const startedResult = readStartedMarker(startedPath);
  if (!startedResult.record) {
    problems.push(`malformed_started_marker:${startedPath}:${startedResult.problem}`);
    return;
  }
  const started = startedResult.record;
  const terminalPath = startedPath.replace(/\.started\.json$/, '.terminal.json');
  const terminal = validateTerminal(terminalPath, started, problems);
  if (!terminal) return;
  const journalPath = confinedJournalPath(
    root,
    String(started.journal_path),
    canonicalRoot,
  );
  if (!journalPath) {
    problems.push(`journal_outside_root:${started.journal_path}`);
    return;
  }
  const scan = scanJournal(journalPath, expectedRoleIdentities);
  validateScan(scan, terminal, journalPath, problems, expectedStateAdmission);
  validateMarkerIdentity(started, scan.header, journalPath, problems);
  validateTerminalIdentities(terminal, scan.header, journalPath, problems);
}

function startedJournalScan(input: {
  trajectoryRoot: string;
  canonicalTrajectoryRoot?: true;
  rootRunId: string;
  threadId: string | null;
}): JournalScanResult {
  const startedPath = resolveLifecyclePaths(input).started;
  const started = readStartedMarker(startedPath);
  if (!started.record || started.record.root_run_id !== input.rootRunId
    || started.record.thread_id !== input.threadId) {
    throw new TrajectoryWriteFailedError(`Cannot read parent lifecycle identity: ${startedPath}`);
  }
  const journalPath = confinedJournalPath(
    input.trajectoryRoot,
    String(started.record.journal_path),
    input.canonicalTrajectoryRoot === true,
  );
  if (!journalPath) throw new TrajectoryWriteFailedError('Parent journal is outside trajectory root');
  const scan = scanJournal(journalPath);
  const linked = scan.header?.rootRunId === input.rootRunId
    && scan.header.threadId === input.threadId;
  if (!scan.header || scan.problems.length > 0 || !linked) {
    throw new TrajectoryWriteFailedError(`Cannot validate parent journal: ${scan.problems.join(',')}`);
  }
  return scan;
}

export interface StartedJournalIdentity extends JournalHeaderRecord {
  requestedModel: string;
  provider: string | null;
}

export function readStartedJournalIdentity(input: {
  trajectoryRoot: string;
  canonicalTrajectoryRoot?: true;
  rootRunId: string;
  threadId: string | null;
}): StartedJournalIdentity {
  const scan = startedJournalScan(input);
  if (!scan.modelObservation) {
    throw new TrajectoryWriteFailedError('Parent journal has no model observation');
  }
  return { ...scan.header!, ...scan.modelObservation };
}

export function validateTrajectoryLifecycle(input: {
  trajectoryRoot: string;
  canonicalTrajectoryRoot?: true;
  rootRunId: string;
  threadId: string | null;
  roleIdentities?: ReadonlyMap<string, JournalRoleIdentity>;
  stateAdmission?: StateAdmissionEvidence;
}): { ok: boolean; problems: string[] } {
  const started = resolveLifecyclePaths(input).started;
  if (!fs.existsSync(started)) return { ok: false, problems: [`missing_started_marker:${started}`] };
  const problems: string[] = [];
  validateStarted(
    input.trajectoryRoot,
    started,
    problems,
    input.roleIdentities,
    input.canonicalTrajectoryRoot === true,
    input.stateAdmission,
  );
  return { ok: problems.length === 0, problems };
}

export interface TrajectoryRootValidationOptions {
  parentStateAdmission?: StateAdmissionEvidence;
}

export function validateTrajectoryRoot(
  root: string,
  options: TrajectoryRootValidationOptions = {},
): { ok: boolean; problems: string[] } {
  let startedFiles: string[];
  try {
    startedFiles = fs.readdirSync(root).filter(name => name.endsWith('.started.json')).sort();
  } catch {
    const problems = [`trajectory_root_unreadable:${root}`];
    return { ok: false, problems };
  }
  const problems: string[] = [];
  for (const name of startedFiles) {
    validateStarted(
      root,
      path.join(root, name),
      problems,
      undefined,
      false,
      name.startsWith('run-') ? options.parentStateAdmission : undefined,
    );
  }
  return { ok: problems.length === 0, problems };
}
