import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '../core/atomic-write.js';
import {
  defaultHookRegistryDirs,
  loadHookRegistryRecords,
  validateHookEntry,
  type BuiltinHookLayer,
  type HookBackend,
  type HookEntry,
  type HookFilterValue,
  type HookRegistryDirs,
  type HookRegistryRecord,
  type HookResultMode,
  type HookRun,
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

/** New user declarations sort after the shipped `01-`…`13-` block. */
const USER_PREFIX = '50-';

function hookError(code: 'not-found' | 'invalid-args', message: string): Error {
  return Object.assign(new Error(message), { code });
}

function findRecord(dirs: HookRegistryDirs, id: string): HookRegistryRecord {
  const record = loadHookRegistryRecords(dirs).find((candidate) => candidate.entry.id === id);
  if (!record) throw hookError('not-found', `Unknown hook id: '${id}'`);
  return record;
}

/** A built-in is changed only through its switch; its other fields follow the shipped entry. */
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
 * spread, so anything the caller did not ask for is dropped.
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

/** Keep the override to what differs from the shipped entry; an empty override is no file at all,
 *  which is what switching a built-in back on reverts to. */
function writeBuiltinEnabled(layer: BuiltinHookLayer, enabled: boolean): void {
  const override: Record<string, unknown> = { ...(layer.override ?? {}) };
  delete override.version;
  if ((layer.entry.enabled !== false) === enabled) delete override.enabled;
  else override.enabled = enabled;
  if (Object.keys(override).length === 0) {
    fs.rmSync(layer.overridePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(layer.overridePath), { recursive: true });
  atomicWriteSync(layer.overridePath, `${JSON.stringify(override, null, 2)}\n`);
}

/**
 * Flip `enabled` on one registry declaration. A user entry is rewritten in place; a built-in gets a
 * partial override in the user's hooks dir, removed again when it is switched back to its default.
 */
export function setHookEnabled(
  dirs: HookRegistryDirs = defaultHookRegistryDirs(),
  id: string,
  enabled: boolean,
): HookStateResult {
  const record = findRecord(dirs, id);
  const changed = (record.entry.enabled !== false) !== enabled;
  if (!changed) return { changed };
  if (record.builtin) writeBuiltinEnabled(record.builtin, enabled);
  else atomicWriteSync(record.filePath, serialize({ ...record.entry, enabled }));
  return { changed };
}

/** Write a new user declaration as `50-<id>.json`. */
export function createHookEntry(
  dirs: HookRegistryDirs = defaultHookRegistryDirs(),
  draft: HookEntryDraft & { id: string },
): HookCreateResult {
  const dir = dirs.user;
  const id = draft.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw hookError(
      'invalid-args',
      `Hook id '${String(id)}' must start with a letter or digit and contain only letters, digits, '-' and '_'`,
    );
  }
  if (loadHookRegistryRecords(dirs).some((record) => record.entry.id === id)) {
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
  dirs: HookRegistryDirs = defaultHookRegistryDirs(),
  id: string,
  draft: HookEntryDraft,
): HookStateResult {
  const record = findRecord(dirs, id);
  assertEditable(record);
  const entry = buildEntry(id, draft);
  const changed = JSON.stringify(entry) !== JSON.stringify(record.entry);
  if (changed) atomicWriteSync(record.filePath, serialize(entry));
  return { changed };
}

/** Delete one user declaration file. */
export function removeHookEntry(dirs: HookRegistryDirs = defaultHookRegistryDirs(), id: string): HookRemoveResult {
  const record = findRecord(dirs, id);
  assertEditable(record);
  fs.rmSync(record.filePath, { force: true });
  return { removed: true };
}
