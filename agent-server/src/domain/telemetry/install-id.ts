import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { INSTALL_ID_FILE } from './paths.js';

const cache = new Map<string, string>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isInstallId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function readInstallId(file: string): string | null {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return isInstallId(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

function writeInstallId(file: string, id: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** The random per-install id, created on first use. Carries no machine or user information. */
export function getInstallId(file: string = INSTALL_ID_FILE): string {
  const onDisk = readInstallId(file);
  const id = onDisk ?? cache.get(file) ?? randomUUID();
  if (!onDisk) {
    try { writeInstallId(file, id); } catch { /* unwritable home: the id lives for this process */ }
  }
  cache.set(file, id);
  return id;
}

/** Take over an id generated elsewhere (the desktop shell hands its own to `cortex init`). */
export function adoptInstallId(id: string, file: string = INSTALL_ID_FILE): void {
  if (!isInstallId(id)) throw new Error('install id must be a UUID');
  writeInstallId(file, id.toLowerCase());
  cache.set(file, id.toLowerCase());
}
