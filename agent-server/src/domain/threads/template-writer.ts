// input:  a thread-templates directory + an entity kind/name/body and the hash it was read at
// output: readEntity / saveEntity / removeEntity / entityPath — validated, atomic, guarded writes
// pos:    The write half of the thread-template config, mirroring store/hook-writer.ts. Nothing
//         wrote these files before except the one-time legacy migration, so every rule about what
//         may be written lives here: the filename IS the identity (the loader keys on the basename
//         and skips a file whose `name` disagrees), validation errors block the write, and an
//         optimistic baseHash stops a stale editor from clobbering an edit that landed underneath
//         it — a real risk because the config is git-synced across machines and hot-reloaded.
//         Deletes are reference-guarded. No backups: the directory is git-tracked, so git is undo.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '@core/atomic-write.js';
import {
  validateEntity,
  withCandidate,
  rawRegistryFromDir,
  dependentTemplates,
  type EntityKind,
  type Issue,
  type RefResolver,
} from './template-validate.js';

/** Filename-safe entity name: rules out path separators, `..`, and leading punctuation. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const SUBDIR: Record<EntityKind, string> = {
  agent: 'agents',
  template: 'templates',
  shell: 'shells',
};

export type WriteErrorCode = 'not-found' | 'invalid-args' | 'conflict';

/** Carries the validation issues so the UI can anchor them at their fields. */
export interface TemplateWriteError extends Error {
  code: WriteErrorCode;
  issues?: Issue[];
}

function writeError(code: WriteErrorCode, message: string, issues?: Issue[]): TemplateWriteError {
  return Object.assign(new Error(message), { code, ...(issues ? { issues } : {}) });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function entityPath(dir: string, kind: EntityKind, name: string): string {
  return path.join(dir, SUBDIR[kind], `${name}.json`);
}

function assertName(name: string): void {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw writeError(
      'invalid-args',
      `Name '${String(name)}' must start with a letter or digit and contain only letters, digits, '-' and '_'`,
    );
  }
}

/** `JSON.stringify(…, 2)` + trailing newline — the format the migration writer already produced. */
function serialize(body: unknown): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}

const io = {
  readdirSync: (p: string) => readdirSync(p),
  readFileSync: (p: string, enc: 'utf8') => readFileSync(p, enc),
  existsSync,
  join: path.join,
};

export interface EntityRead {
  kind: EntityKind;
  name: string;
  filePath: string;
  /** Raw parsed body, or null when the file on disk is not parseable JSON. */
  body: Record<string, unknown> | null;
  /** Hash of the exact bytes on disk — pass back as `baseHash` to save safely. */
  sha256: string;
}

export function readEntity(dir: string, kind: EntityKind, name: string): EntityRead {
  assertName(name);
  const filePath = entityPath(dir, kind, name);
  if (!existsSync(filePath)) {
    throw writeError('not-found', `Unknown ${kind}: '${name}'`);
  }
  const raw = readFileSync(filePath, 'utf8');
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  } catch {
    body = null;
  }
  return { kind, name, filePath, body, sha256: sha256(raw) };
}

export interface SaveInput {
  kind: EntityKind;
  name: string;
  body: unknown;
  /** sha256 of the content the editor started from. `null` means "create — must not exist yet". */
  baseHash: string | null;
}

export interface SaveResult {
  changed: boolean;
  filePath: string;
  /** Non-blocking issues the caller should surface after the write. */
  warnings: Issue[];
  /** Hash of what is now on disk, so the editor can keep saving without a reload. */
  sha256: string;
}

/**
 * Create or replace one entity file. The body is the complete desired state — omitted fields are
 * removed, not merged, because the editor always holds the whole document.
 *
 * Validation runs against the registry with this candidate already swapped in, so a change is
 * judged by the world it produces rather than the one it replaces. Errors block the write.
 */
export function saveEntity(dir: string, input: SaveInput, refs?: RefResolver): SaveResult {
  const { kind, name, body, baseHash } = input;
  assertName(name);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw writeError('invalid-args', 'Body must be a JSON object');
  }

  const filePath = entityPath(dir, kind, name);
  const exists = existsSync(filePath);
  const current = exists ? readFileSync(filePath, 'utf8') : null;

  if (baseHash === null && exists) {
    throw writeError('invalid-args', `${kind} '${name}' already exists`);
  }
  if (baseHash !== null && !exists) {
    throw writeError('not-found', `Unknown ${kind}: '${name}'`);
  }
  if (baseHash !== null && current !== null && sha256(current) !== baseHash) {
    throw writeError(
      'conflict',
      `${kind} '${name}' changed on disk since it was loaded — reload before saving to avoid discarding that edit`,
    );
  }

  const registry = withCandidate(rawRegistryFromDir(dir, io), kind, name, body);
  const { errors, warnings } = validateEntity(kind, name, body, registry, refs);
  if (errors.length > 0) {
    throw writeError(
      'invalid-args',
      `${kind} '${name}' is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      errors,
    );
  }

  const next = serialize(body);
  const changed = current !== next;
  if (changed) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteSync(filePath, next);
  }
  return { changed, filePath, warnings, sha256: sha256(next) };
}

export interface RemoveResult {
  removed: boolean;
  filePath: string;
}

/**
 * Delete one entity file. Refuses while another template still declares this agent or binds this
 * shell — the loader would keep skipping that template, and any thread on it would stall.
 * Templates themselves have no config-level dependents; task and running-thread references are the
 * caller's to check, since they live outside this directory.
 */
export function removeEntity(dir: string, kind: EntityKind, name: string): RemoveResult {
  assertName(name);
  const filePath = entityPath(dir, kind, name);
  if (!existsSync(filePath)) {
    throw writeError('not-found', `Unknown ${kind}: '${name}'`);
  }

  const dependents = dependentTemplates(kind, name, rawRegistryFromDir(dir, io));
  if (dependents.length > 0) {
    throw writeError(
      'invalid-args',
      `${kind} '${name}' is still used by ${dependents.length} template(s): ${dependents.join(', ')}`,
    );
  }

  rmSync(filePath, { force: true });
  return { removed: true, filePath };
}

/** Every entity name present on disk, by kind. */
export function listEntityNames(dir: string, kind: EntityKind): string[] {
  const full = path.join(dir, SUBDIR[kind]);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}
