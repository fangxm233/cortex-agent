// input:  frozen production identity and closed journal record
// output: verified journal bytes and normalized event projection
// pos:    Production evidence journal reader
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';

import type {
  SourceJournalEvent, SourceJournalHeader,
} from '../agent-run/atif.js';
import type { ProductionAttemptIdentityRecord } from '../agent-run/production-attempt-identity.js';
import type { ProductionAttemptJournalRecord } from '../agent-run/production-attempt-journal.js';

export interface ParsedProductionJournal {
  readonly bytes: Buffer;
  readonly header: SourceJournalHeader;
  readonly events: readonly SourceJournalEvent[];
  readonly reportedModel: string | null;
  readonly rateLimited: boolean;
}

function fail(detail: string): never {
  throw new Error(`production evidence journal invalid: ${detail}`);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseRows(bytes: Buffer, label: string): Record<string, unknown>[] {
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) fail(`${label} is incomplete`);
  return bytes.toString('utf8').trimEnd().split('\n').map((line, index) => {
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      return fail(`${label} row ${index + 1} is malformed`);
    }
  });
}

function assertHeader(
  header: Record<string, unknown>, identity: ProductionAttemptIdentityRecord,
): void {
  const checks: Array<[unknown, unknown, string]> = [
    [header.schema_version, 'cortex-bench-journal/1', 'schema'],
    [header.type, 'run_header', 'header'],
    [header.root_run_id, identity.root_run_id, 'root run'],
    [header.thread_id, identity.thread_id, 'thread'],
    [header.agent_slot, identity.role, 'role'],
    [header.model_execution_identity_hash, identity.model_execution_identity_hash, 'model identity'],
    [header.role_tool_surface_hash, identity.role_tool_surface_hash, 'role identity'],
    [header.bundle_manifest_hash, identity.bundle_manifest_hash, 'bundle identity'],
  ];
  const mismatch = checks.find(([actual, expected]) => actual !== expected);
  if (mismatch) fail(`${mismatch[2]} mismatch for ${identity.attempt_id}`);
}

function assertEvent(
  row: Record<string, unknown>, identity: ProductionAttemptIdentityRecord,
): void {
  if (row.schema_version !== 'cortex-bench-journal/1' || row.type !== 'event') {
    fail(`event schema mismatch for ${identity.attempt_id}`);
  }
  const fields: Array<[unknown, unknown]> = [
    [row.root_run_id, identity.root_run_id], [row.thread_id, identity.thread_id],
    [row.agent_slot, identity.role], [row.backend, identity.backend],
    [row.provider, identity.provider], [row.requested_model, identity.requested_model],
    [row.model_execution_identity_hash, identity.model_execution_identity_hash],
    [row.role_tool_surface_hash, identity.role_tool_surface_hash],
    [row.bundle_manifest_hash, identity.bundle_manifest_hash],
  ];
  if (fields.some(([actual, expected]) => actual !== expected)) {
    fail(`event identity mismatch for ${identity.attempt_id}`);
  }
}

export function parseProductionEvidenceJournal(
  record: ProductionAttemptJournalRecord, identity: ProductionAttemptIdentityRecord,
): ParsedProductionJournal {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(record.journal_path); }
  catch { return fail(`bytes missing for ${identity.attempt_id}`); }
  if (sha256(bytes) !== record.journal_sha256) fail(`hash mismatch for ${identity.attempt_id}`);
  const rows = parseRows(bytes, identity.attempt_id);
  assertHeader(rows[0] ?? {}, identity);
  const events = rows.slice(1);
  if (events.length !== record.event_count) fail(`event count mismatch for ${identity.attempt_id}`);
  events.forEach(row => assertEvent(row, identity));
  const models = events.map(row => row.reported_model)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return {
    bytes, header: rows[0] as SourceJournalHeader,
    events: events as unknown as SourceJournalEvent[],
    reportedModel: models.at(-1) ?? null,
    rateLimited: events.some(row => (
      (row.event as Record<string, unknown> | undefined)?.type === 'rate_limit'
    )),
  };
}
