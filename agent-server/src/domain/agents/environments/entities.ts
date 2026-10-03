import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '@core/atomic-write.js';
import { t } from '@core/i18n.js';
import type { RefResolver } from './file-refs.js';
import { validateEnvironment, type Issue } from './schema.js';

/** Filename-safe environment name: rules out path separators, `..`, and leading punctuation. */
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type EnvironmentWriteErrorCode = 'not-found' | 'invalid-args' | 'conflict';

/** Carries the validation issues so the UI can anchor them at their fields. */
export interface EnvironmentWriteError extends Error {
  code: EnvironmentWriteErrorCode;
  issues?: Issue[];
}

function writeError(code: EnvironmentWriteErrorCode, message: string, issues?: Issue[]): EnvironmentWriteError {
  return Object.assign(new Error(message), { code, ...(issues ? { issues } : {}) });
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertName(name: string): void {
  if (typeof name !== 'string' || !ENVIRONMENT_NAME_PATTERN.test(name)) {
    throw writeError('invalid-args', t('ux.tpl.invalidName', { name: String(name) }));
  }
}

export function environmentPath(dir: string, name: string): string {
  return path.join(dir, `${name}.json`);
}

/** Every environment name present on disk, sorted. */
export function listEnvironmentNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export interface EnvironmentRead {
  name: string;
  filePath: string;
  /** Raw parsed body, or null when the file on disk is not a JSON object. */
  body: Record<string, unknown> | null;
  /** Exact bytes on disk, for comparisons against the shipped default. */
  content: string;
  /** Hash of the exact bytes on disk — pass back as `baseHash` to save safely. */
  sha256: string;
}

export function readEnvironment(dir: string, name: string): EnvironmentRead {
  assertName(name);
  const filePath = environmentPath(dir, name);
  if (!existsSync(filePath)) {
    throw writeError('not-found', t('ux.tpl.unknownEntity', { kind: 'agent', name }));
  }
  const content = readFileSync(filePath, 'utf8');
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  } catch {
    body = null;
  }
  return { name, filePath, body, content, sha256: sha256(content) };
}

export interface SaveEnvironmentInput {
  name: string;
  body: unknown;
  /** sha256 of the content the editor started from. `null` means "create — must not exist yet". */
  baseHash: string | null;
}

export interface SaveEnvironmentResult {
  changed: boolean;
  filePath: string;
  /** Non-blocking issues the caller should surface after the write. */
  warnings: Issue[];
  /** Hash of what is now on disk, so the editor can keep saving without a reload. */
  sha256: string;
}

/**
 * Create or replace one environment file. The body is the complete desired state — omitted fields
 * are removed, not merged, because the editor always holds the whole document. Validation errors
 * block the write; a stale `baseHash` is a conflict.
 */
export function saveEnvironment(dir: string, input: SaveEnvironmentInput, refs?: RefResolver): SaveEnvironmentResult {
  const { name, body, baseHash } = input;
  assertName(name);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw writeError('invalid-args', t('ux.tpl.bodyNotObject'));
  }
  const filePath = environmentPath(dir, name);
  const exists = existsSync(filePath);
  const current = exists ? readFileSync(filePath, 'utf8') : null;
  if (baseHash === null && exists) {
    throw writeError('invalid-args', t('ux.tpl.alreadyExists', { kind: 'agent', name }));
  }
  if (baseHash !== null && !exists) {
    throw writeError('not-found', t('ux.tpl.unknownEntity', { kind: 'agent', name }));
  }
  if (baseHash !== null && current !== null && sha256(current) !== baseHash) {
    throw writeError('conflict', t('ux.tpl.changedOnDisk', { kind: 'agent', name }));
  }
  const { errors, warnings } = validateEnvironment(name, body, refs);
  if (errors.length > 0) {
    throw writeError(
      'invalid-args',
      t('ux.tpl.notValid', { kind: 'agent', name, issues: errors.map((e) => `${e.path}: ${e.message}`).join('; ') }),
      errors,
    );
  }
  const next = `${JSON.stringify(body, null, 2)}\n`;
  const changed = current !== next;
  if (changed) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteSync(filePath, next);
  }
  return { changed, filePath, warnings, sha256: sha256(next) };
}

/** Delete one environment file. */
export function removeEnvironment(dir: string, name: string): { removed: boolean; filePath: string } {
  assertName(name);
  const filePath = environmentPath(dir, name);
  if (!existsSync(filePath)) {
    throw writeError('not-found', t('ux.tpl.unknownEntity', { kind: 'agent', name }));
  }
  rmSync(filePath, { force: true });
  return { removed: true, filePath };
}
