// input:  frozen attempt identity, spawn config, normalized events
// output: durable production journals and immutable linkage records
// pos:    Production normalized-event journal persistence boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR, resolveSpawnCwd } from '../../core/paths.js';
import type { AgentSpawnConfig } from '../../agent-adapter/types.js';
import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import type { EventObserver } from '../../agent-adapter/event-tee.js';
import { canonicalJsonSha256, computeRoleToolSurfaceHash } from './identity.js';
import { openJournal, type Journal } from './journal.js';
import type { ProductionAttemptIdentityRecord } from './production-attempt-identity.js';
import { roleSurfaceFromSpawnConfig } from './role-surface.js';

const RECORD_SCHEMA = 'cortex-production-attempt-journal/1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_JOURNAL_DIR = path.join(STORE_DIR, 'benchmark-attempt-journals');
const DEFAULT_STORE_PATH = path.join(STORE_DIR, 'benchmark-attempt-journals.jsonl');
const RECORD_KEYS = [
  'schema_version', 'attempt_id', 'execution_id', 'journal_path',
  'journal_sha256', 'event_count', 'closed_at',
] as const;

export type ProductionAttemptJournalRecord = Readonly<{
  schema_version: typeof RECORD_SCHEMA;
  attempt_id: string;
  execution_id: string;
  journal_path: string;
  journal_sha256: string;
  event_count: number;
  closed_at: string;
}>;

export interface ProductionAttemptJournalInit {
  journalDir?: string;
  storePath?: string;
}

export interface ProductionAttemptJournalInput {
  identity: ProductionAttemptIdentityRecord;
  spawnConfig: AgentSpawnConfig;
  canonicalInstruction: string;
  message: string;
}

interface JournalScan {
  sha256: string;
  eventCount: number;
}

let activeRepo: ProductionAttemptJournalRepo | null = null;
let activeJournalDir = DEFAULT_JOURNAL_DIR;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>): boolean {
  const expected = new Set(RECORD_KEYS);
  return RECORD_KEYS.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => expected.has(key as typeof RECORD_KEYS[number]));
}

function isRequiredText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function storedRecordValid(value: Record<string, unknown>): boolean {
  return exactKeys(value)
    && value.schema_version === RECORD_SCHEMA
    && isRequiredText(value.attempt_id)
    && isRequiredText(value.execution_id)
    && isRequiredText(value.journal_path)
    && path.isAbsolute(value.journal_path)
    && typeof value.journal_sha256 === 'string'
    && SHA256_PATTERN.test(value.journal_sha256)
    && Number.isInteger(value.event_count)
    && Number(value.event_count) >= 0
    && isRequiredText(value.closed_at)
    && !Number.isNaN(Date.parse(value.closed_at));
}

function parseStoredRecord(text: string, line: number): ProductionAttemptJournalRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new Error(`Production attempt journal store malformed at line ${line}`);
  }
  if (!isRecord(parsed) || !storedRecordValid(parsed)) {
    throw new Error(`Production attempt journal store invalid at line ${line}`);
  }
  return parsed as unknown as ProductionAttemptJournalRecord;
}

function scanJournal(filePath: string): JournalScan {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    throw new Error(`Production attempt journal is empty or incomplete: ${filePath}`);
  }
  const lines = bytes.toString('utf8').trimEnd().split('\n');
  const records = lines.map((line, index) => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error(`Production attempt journal malformed at ${filePath}:${index + 1}`); }
  });
  if (records[0]?.type !== 'run_header') {
    throw new Error(`Production attempt journal header missing: ${filePath}`);
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    eventCount: records.slice(1).filter(record => record.type === 'event').length,
  };
}

function verifyEvidence(record: ProductionAttemptJournalRecord): void {
  const scan = scanJournal(record.journal_path);
  if (scan.sha256 !== record.journal_sha256) {
    throw new Error(`Production attempt journal digest mismatch: ${record.execution_id}`);
  }
  if (scan.eventCount !== record.event_count) {
    throw new Error(`Production attempt journal event count mismatch: ${record.execution_id}`);
  }
}

function sameRecord(
  left: ProductionAttemptJournalRecord,
  right: ProductionAttemptJournalRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ProductionAttemptJournalRepo {
  private readonly byExecution = new Map<string, ProductionAttemptJournalRecord>();
  private readonly byAttempt = new Map<string, ProductionAttemptJournalRecord>();

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
      verifyEvidence(record);
      this.remember(record);
    });
  }

  private remember(record: ProductionAttemptJournalRecord): ProductionAttemptJournalRecord {
    const execution = this.byExecution.get(record.execution_id);
    const attempt = this.byAttempt.get(record.attempt_id);
    if ((execution && !sameRecord(execution, record)) || (attempt && !sameRecord(attempt, record))) {
      throw new Error(`Production attempt journal identity collision: ${record.execution_id}`);
    }
    if (execution) return execution;
    const immutable = Object.freeze({ ...record });
    this.byExecution.set(record.execution_id, immutable);
    this.byAttempt.set(record.attempt_id, immutable);
    return immutable;
  }

  get(executionId: string): ProductionAttemptJournalRecord | null {
    return this.byExecution.get(executionId) ?? null;
  }

  append(record: ProductionAttemptJournalRecord): ProductionAttemptJournalRecord {
    const existing = this.get(record.execution_id);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw new Error(`Production attempt journal changed for execution ${record.execution_id}`);
      }
      return existing;
    }
    verifyEvidence(record);
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

function journalFileName(identity: ProductionAttemptIdentityRecord): string {
  const digest = createHash('sha256').update(identity.attempt_id).digest('hex');
  return `${digest}.ndjson`;
}

function valueSha256(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function promptHashes(input: ProductionAttemptJournalInput) {
  const role = roleSurfaceFromSpawnConfig(
    input.spawnConfig, input.canonicalInstruction,
  );
  if (computeRoleToolSurfaceHash(role) !== input.identity.role_tool_surface_hash) {
    throw new Error('Production attempt journal role identity drifted before open');
  }
  return {
    canonicalInstructionSha256: valueSha256(input.canonicalInstruction),
    modelVisiblePromptSha256: valueSha256(input.message),
    systemPromptSha256: role.systemPromptSha256,
    toolManifestSha256: canonicalJsonSha256(role.tools),
    pluginManifestSha256: canonicalJsonSha256({
      plugin_dirs: role.pluginDirs, skills: role.skills,
    }),
  };
}

function journalHeader(input: ProductionAttemptJournalInput) {
  const { identity, spawnConfig } = input;
  return {
    rootRunId: identity.root_run_id,
    threadId: identity.thread_id,
    agentSlot: identity.role,
    resolvedCwd: resolveSpawnCwd(spawnConfig.cwd),
    ...promptHashes(input),
    modelExecutionIdentityHash: identity.model_execution_identity_hash,
    roleToolSurfaceHash: identity.role_tool_surface_hash,
    bundleManifestHash: identity.bundle_manifest_hash,
  };
}

function reportedModel(event: NormalizedEvent): string | null {
  if (!('model' in event)) return null;
  return typeof event.model === 'string' && event.model.length > 0 ? event.model : null;
}

class ProductionAttemptJournalSink implements EventObserver {
  private closed = false;
  private writeFailure: unknown = null;

  constructor(
    private readonly identity: ProductionAttemptIdentityRecord,
    private readonly journal: Journal,
    private readonly repo: ProductionAttemptJournalRepo,
  ) {}

  onEvent(event: NormalizedEvent): void {
    try {
      this.journal.writeEvent({
        threadId: this.identity.thread_id,
        step: null,
        agentSlot: this.identity.role,
        backend: this.identity.backend,
        provider: this.identity.provider,
        requestedModel: this.identity.requested_model,
        reportedModel: reportedModel(event),
        event,
      });
    } catch (error) {
      this.writeFailure ??= error;
      throw error;
    }
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.journal.closeSync();
    if (this.writeFailure) throw this.writeFailure;
    this.repo.append(Object.freeze({
      schema_version: RECORD_SCHEMA,
      attempt_id: this.identity.attempt_id,
      execution_id: this.identity.execution_id,
      journal_path: path.resolve(this.journal.path),
      journal_sha256: this.journal.sha256(),
      event_count: this.journal.eventCount,
      closed_at: new Date().toISOString(),
    }));
  }
}

export function initializeProductionAttemptJournals(
  init: ProductionAttemptJournalInit = {},
): void {
  activeJournalDir = path.resolve(init.journalDir ?? DEFAULT_JOURNAL_DIR);
  activeRepo = new ProductionAttemptJournalRepo(init.storePath ?? DEFAULT_STORE_PATH);
}

export function resetProductionAttemptJournals(): void {
  activeRepo = null;
  activeJournalDir = DEFAULT_JOURNAL_DIR;
}

export function createProductionAttemptJournalSink(
  input: ProductionAttemptJournalInput,
): EventObserver {
  if (!activeRepo) throw new Error('Production attempt journal store is not initialized');
  if (activeRepo.get(input.identity.execution_id)) {
    throw new Error(`Production attempt journal already exists for execution ${input.identity.execution_id}`);
  }
  fs.mkdirSync(activeJournalDir, { recursive: true, mode: 0o700 });
  const journal = openJournal({
    path: path.join(activeJournalDir, journalFileName(input.identity)),
    header: journalHeader(input),
  });
  return new ProductionAttemptJournalSink(input.identity, journal, activeRepo);
}

export function getProductionAttemptJournal(
  executionId: string,
): ProductionAttemptJournalRecord | null {
  return activeRepo?.get(executionId) ?? null;
}
