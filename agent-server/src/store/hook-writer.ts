// input:  hook registry directory, entry drafts, hook ids
// output: create/update/remove/setEnabled writers with source guards
// pos:    Declarative hook registry write side
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '../core/atomic-write.js';
import { CONFIG_DIR } from '../core/paths.js';
import {
  loadHookRegistryRecords,
  validateHookEntry,
  type HookBackend,
  type HookEntry,
  type HookFilterValue,
  type HookRegistryRecord,
  type HookResultMode,
  type HookRun,
  type HookSource,
} from './hook-registry.js';

/** The writable surface of a declaration: everything except `id` and `version`. */
export interface HookEntryDraft {
  event: string;
  matcher?: string | Record<string, HookFilterValue>;
  run: HookRun;
  scope?: { backends?: HookBackend[]; requiresTool?: string };
  blocking?: { mode: 'webhook'; ttlMin: number };
  result?: HookResultMode;
  enabled?: boolean;
}

export interface HookStateResult {
  changed: boolean;
  filePath: string;
  source: HookSource;
  /** Set when the change is not durable — a managed entry restored by the next sync. */
  warning?: string;
}

export interface HookCreateResult {
  id: string;
  filePath: string;
}

export interface HookRemoveResult {
  removed: boolean;
}

/** Filename-safe id: rules out path separators, `..`, and leading punctuation. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** New user declarations sort after the shipped `01-`…`12-` block. */
const USER_PREFIX = '50-';

export const MANAGED_RESYNC_WARNING =
  'A managed hook sync that deploys a newer version will restore the shipped enabled state.';

function hookError(code: 'not-found' | 'invalid-args', message: string): Error {
  return Object.assign(new Error(message), { code });
}

function registryDir(directory?: string): string {
  return directory ?? path.join(CONFIG_DIR, 'hooks');
}

function findRecord(directory: string, id: string): HookRegistryRecord {
  const record = loadHookRegistryRecords(directory).find((candidate) => candidate.entry.id === id);
  if (!record) throw hookError('not-found', `Unknown hook id: '${id}'`);
  return record;
}

/** Registry entries carrying a CalVer are refreshed from defaults — editing them is not durable. */
function assertEditable(record: HookRegistryRecord): void {
  if (record.source !== 'user') {
    throw hookError(
      'invalid-args',
      `Hook '${record.entry.id}' is ${record.source}; only user entries can be edited or removed`,
    );
  }
}

function buildRun(run: HookRun | undefined): HookRun {
  if (typeof run !== 'object' || run === null) {
    throw hookError('invalid-args', 'run must be an object');
  }
  const next: Record<string, unknown> = {};
  if ((run as { script?: unknown }).script !== undefined) next.script = (run as { script: unknown }).script;
  if ((run as { command?: unknown }).command !== undefined) next.command = (run as { command: unknown }).command;
  if (run.timeout !== undefined) next.timeout = run.timeout;
  return next as HookRun;
}

/**
 * Assemble a declaration from an id plus a draft. Fields are copied one at a time rather than
 * spread, so anything the caller did not ask for is dropped — in particular `version`, which is
 * what marks an entry as managed. A forged `version` would make the next hook sync treat a user
 * file as shipped and overwrite it.
 */
function buildEntry(id: string, draft: HookEntryDraft): HookEntry {
  const entry: Record<string, unknown> = { id, event: draft.event };
  if (draft.matcher !== undefined) entry.matcher = draft.matcher;
  entry.run = buildRun(draft.run);
  if (draft.scope !== undefined) entry.scope = draft.scope;
  if (draft.blocking !== undefined) entry.blocking = draft.blocking;
  if (draft.result !== undefined) entry.result = draft.result;
  if (draft.enabled !== undefined) entry.enabled = draft.enabled;
  try {
    return validateHookEntry(entry);
  } catch (error) {
    throw hookError('invalid-args', error instanceof Error ? error.message : String(error));
  }
}

function serialize(entry: HookEntry): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
}

/**
 * Flip `enabled` on one registry declaration, preserving every other field including `version`.
 * Managed entries are allowed here (unlike edit/remove) because the toggle is the one change the
 * sync can meaningfully round-trip — but the caller is told the change is temporary.
 */
export function setHookEnabled(
  directory: string | undefined,
  id: string,
  enabled: boolean,
): HookStateResult {
  const dir = registryDir(directory);
  const record = findRecord(dir, id);
  const changed = (record.entry.enabled !== false) !== enabled;
  if (changed) {
    atomicWriteSync(record.filePath, serialize({ ...record.entry, enabled }));
  }
  const result: HookStateResult = { changed, filePath: record.filePath, source: record.source };
  if (record.source === 'managed' && !enabled) result.warning = MANAGED_RESYNC_WARNING;
  return result;
}

/** Write a new user declaration as `50-<id>.json`. Never stamps a version. */
export function createHookEntry(
  directory: string | undefined,
  draft: HookEntryDraft & { id: string },
): HookCreateResult {
  const dir = registryDir(directory);
  const id = draft.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw hookError(
      'invalid-args',
      `Hook id '${String(id)}' must start with a letter or digit and contain only letters, digits, '-' and '_'`,
    );
  }
  if (loadHookRegistryRecords(dir).some((record) => record.entry.id === id)) {
    throw hookError('invalid-args', `Hook id '${id}' already exists in the registry`);
  }
  const entry = buildEntry(id, draft);
  const filePath = path.join(dir, `${USER_PREFIX}${id}.json`);
  if (fs.existsSync(filePath)) {
    throw hookError('invalid-args', `${path.basename(filePath)} already exists`);
  }
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(filePath, serialize(entry));
  return { id, filePath };
}

/**
 * Replace the body of one user declaration in place. The draft is the complete desired state, so
 * omitted optional fields are removed rather than merged — the UI always holds the whole entry.
 */
export function updateHookEntry(
  directory: string | undefined,
  id: string,
  draft: HookEntryDraft,
): HookStateResult {
  const dir = registryDir(directory);
  const record = findRecord(dir, id);
  assertEditable(record);
  const entry = buildEntry(id, draft);
  const changed = JSON.stringify(entry) !== JSON.stringify(record.entry);
  if (changed) atomicWriteSync(record.filePath, serialize(entry));
  return { changed, filePath: record.filePath, source: record.source };
}

/** Delete one user declaration file. */
export function removeHookEntry(directory: string | undefined, id: string): HookRemoveResult {
  const dir = registryDir(directory);
  const record = findRecord(dir, id);
  assertEditable(record);
  fs.rmSync(record.filePath, { force: true });
  return { removed: true };
}
