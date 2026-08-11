// input:  normalized events, state admission, paths and identity
// output: durable ordered journal records and typed write failures
// pos:    Durable NDJSON writer for one-shot agent runs
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import type { Backend } from '../../agent-adapter/types.js';

const JOURNAL_SCHEMA = 'cortex-bench-journal/1';
const READ_BUFFER_BYTES = 64 * 1024;

export type AgentSlot =
  | 'parent' | 'benchmark-coder' | 'benchmark-reviewer' | 'benchmark-fixer';

export class TrajectoryWriteFailedError extends Error {
  readonly reason = 'trajectory_write_failed' as const;

  constructor(message = 'Trajectory write failed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TrajectoryWriteFailedError';
  }
}

class FilesystemOperationError extends Error {
  constructor(readonly operation: string, cause: unknown) {
    super(`${operation} failed`, { cause });
    this.name = 'FilesystemOperationError';
  }
}

export interface JournalHeaderInput {
  rootRunId: string;
  threadId: string | null;
  agentSlot: AgentSlot;
  resolvedCwd: string;
  canonicalInstructionSha256: string;
  modelVisiblePromptSha256: string;
  systemPromptSha256: string;
  toolManifestSha256: string;
  pluginManifestSha256: string;
  modelExecutionIdentityHash: string;
  roleToolSurfaceHash: string;
  bundleManifestHash: string;
}

export interface JournalEventIdentity {
  modelExecutionIdentityHash: string;
  roleToolSurfaceHash: string;
  bundleManifestHash: string;
}

export interface JournalEventInput {
  threadId: string | null;
  step: number | null;
  agentSlot: AgentSlot;
  backend: Backend;
  provider: string | null;
  requestedModel: string;
  reportedModel: string | null;
  event: NormalizedEvent;
  identity?: JournalEventIdentity;
}

export interface StateAdmissionEvidence {
  schema_version: 'cortex-standalone-state-admission/1';
  empty_before_projection: boolean;
  roots: {
    project: string; task: string; thread: string; session: string; execution: string;
    cache: string; temp: string; backend: string;
  };
}

export interface Journal {
  readonly path: string;
  readonly header: Readonly<Record<string, unknown>>;
  readonly eventCount: number;
  writeStateAdmission(evidence: StateAdmissionEvidence): Readonly<Record<string, unknown>>;
  writeEvent(input: JournalEventInput): Readonly<Record<string, unknown>>;
  sha256(): string;
  close(): Promise<void>;
}

interface IdentityFields {
  rootRunId: string;
  threadId: string | null;
  agentSlot: AgentSlot;
  modelExecutionIdentityHash: string;
  roleToolSurfaceHash: string;
  bundleManifestHash: string;
}

function operationFailure(operation: string, cause: unknown): FilesystemOperationError {
  return new FilesystemOperationError(operation, cause);
}

function trajectoryFailure(context: string, failures: unknown[]): TrajectoryWriteFailedError {
  const cause = failures.length === 1 ? failures[0] : new AggregateError(failures);
  return new TrajectoryWriteFailedError(`${context}: trajectory write failed`, { cause });
}

function throwTrajectoryFailure(context: string, failure: unknown): never {
  if (failure instanceof TrajectoryWriteFailedError) throw failure;
  throw trajectoryFailure(context, [failure]);
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

function buildHeader(input: JournalHeaderInput, ts: string): Record<string, unknown> {
  return {
    schema_version: JOURNAL_SCHEMA,
    type: 'run_header',
    root_run_id: input.rootRunId,
    thread_id: input.threadId,
    agent_slot: input.agentSlot,
    seq: 0,
    ts,
    resolved_cwd: input.resolvedCwd,
    canonical_instruction_sha256: input.canonicalInstructionSha256,
    model_visible_prompt_sha256: input.modelVisiblePromptSha256,
    system_prompt_sha256: input.systemPromptSha256,
    tool_manifest_sha256: input.toolManifestSha256,
    plugin_manifest_sha256: input.pluginManifestSha256,
    model_execution_identity_hash: input.modelExecutionIdentityHash,
    role_tool_surface_hash: input.roleToolSurfaceHash,
    bundle_manifest_hash: input.bundleManifestHash,
  };
}

function buildStateAdmission(
  evidence: StateAdmissionEvidence,
  identity: IdentityFields,
  seq: number,
  ts: string,
): Record<string, unknown> {
  return {
    schema_version: JOURNAL_SCHEMA,
    type: 'state_admission',
    root_run_id: identity.rootRunId,
    thread_id: identity.threadId,
    agent_slot: identity.agentSlot,
    seq,
    ts,
    model_execution_identity_hash: identity.modelExecutionIdentityHash,
    role_tool_surface_hash: identity.roleToolSurfaceHash,
    bundle_manifest_hash: identity.bundleManifestHash,
    evidence,
  };
}

function buildEvent(
  input: JournalEventInput,
  headerIdentity: IdentityFields,
  seq: number,
  ts: string,
): Record<string, unknown> {
  const identity = input.identity ?? headerIdentity;
  return {
    schema_version: JOURNAL_SCHEMA,
    type: 'event',
    root_run_id: headerIdentity.rootRunId,
    thread_id: input.threadId,
    step: input.step,
    agent_slot: input.agentSlot,
    seq,
    ts,
    backend: input.backend,
    provider: input.provider,
    requested_model: input.requestedModel,
    reported_model: input.reportedModel,
    model_execution_identity_hash: identity.modelExecutionIdentityHash,
    role_tool_surface_hash: identity.roleToolSurfaceHash,
    bundle_manifest_hash: identity.bundleManifestHash,
    event: input.event,
  };
}

class FileJournal implements Journal {
  private fd: number | null;
  private nextSeq = 1;
  private count = 0;

  constructor(
    readonly path: string,
    readonly header: Readonly<Record<string, unknown>>,
    fd: number,
    private readonly identity: IdentityFields,
    private readonly now: () => Date,
  ) {
    this.fd = fd;
  }

  get eventCount(): number {
    return this.count;
  }

  writeStateAdmission(evidence: StateAdmissionEvidence): Readonly<Record<string, unknown>> {
    if (this.nextSeq !== 1 || this.identity.threadId !== null || this.identity.agentSlot !== 'parent') {
      throw trajectoryFailure('state admission write', [new Error('state admission must be first')]);
    }
    let record: Readonly<Record<string, unknown>>;
    try {
      const fd = this.requireOpenFd();
      record = buildStateAdmission(evidence, this.identity, this.nextSeq, isoTimestamp(this.now));
      writeFull(fd, serializeLine(record));
    } catch (error) {
      throwTrajectoryFailure('state admission write', error);
    }
    this.nextSeq += 1;
    return record;
  }

  writeEvent(input: JournalEventInput): Readonly<Record<string, unknown>> {
    let record: Readonly<Record<string, unknown>>;
    try {
      const fd = this.requireOpenFd();
      record = buildEvent(input, this.identity, this.nextSeq, isoTimestamp(this.now));
      writeFull(fd, serializeLine(record));
    } catch (error) {
      throwTrajectoryFailure('event write', error);
    }
    this.nextSeq += 1;
    this.count += 1;
    return record;
  }

  sha256(): string {
    const failure = this.fd === null ? null : fsyncFd(this.fd);
    if (failure) throw trajectoryFailure('journal hash flush', [failure]);
    return hashFile(this.path);
  }

  async close(): Promise<void> {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    const failures: unknown[] = [];
    appendFailure(failures, fsyncFd(fd));
    appendFailure(failures, closeFd(fd));
    if (failures.length > 0) throw trajectoryFailure('journal close', failures);
  }

  private requireOpenFd(): number {
    if (this.fd !== null) return this.fd;
    const cause = operationFailure('write', new Error('journal is closed'));
    throw trajectoryFailure('event write', [cause]);
  }
}

function identityFromHeader(header: JournalHeaderInput): IdentityFields {
  return {
    rootRunId: header.rootRunId,
    threadId: header.threadId,
    agentSlot: header.agentSlot,
    modelExecutionIdentityHash: header.modelExecutionIdentityHash,
    roleToolSurfaceHash: header.roleToolSurfaceHash,
    bundleManifestHash: header.bundleManifestHash,
  };
}

function openJournalFd(filePath: string): number {
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT
      | fs.constants.O_EXCL | fs.constants.O_APPEND;
    return fs.openSync(filePath, flags, 0o600);
  } catch (error) {
    throw operationFailure('open', error);
  }
}

function closeAfterOpenFailure(fd: number, failure: unknown): never {
  const failures = [failure];
  appendFailure(failures, closeFd(fd));
  throw trajectoryFailure('journal open', failures);
}

export function openJournal(options: {
  path: string;
  header: JournalHeaderInput;
  now?: () => Date;
}): Journal {
  let fd: number;
  try {
    fd = openJournalFd(options.path);
  } catch (error) {
    throwTrajectoryFailure('journal open', error);
  }
  const now = options.now ?? (() => new Date());
  const header = buildHeader(options.header, isoTimestamp(now));
  try {
    writeFull(fd, serializeLine(header));
  } catch (error) {
    closeAfterOpenFailure(fd, error);
  }
  return new FileJournal(options.path, header, fd, identityFromHeader(options.header), now);
}

function hashOpenFile(fd: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) return hash.digest('hex');
    hash.update(buffer.subarray(0, bytesRead));
  }
}

function hashFile(filePath: string): string {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (error) {
    throw trajectoryFailure('journal hash', [operationFailure('open', error)]);
  }
  let digest: string | null = null;
  const failures: unknown[] = [];
  try {
    digest = hashOpenFile(fd);
  } catch (error) {
    failures.push(operationFailure('read', error));
  }
  appendFailure(failures, closeFd(fd));
  if (failures.length > 0) throw trajectoryFailure('journal hash', failures);
  return digest!;
}
