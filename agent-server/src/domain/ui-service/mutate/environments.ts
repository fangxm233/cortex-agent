import {
  ENVIRONMENTS_DIR,
  fsRefResolver,
  loadEnvironments,
  removeEnvironment,
  saveEnvironment,
  validateEnvironment,
} from '@domain/agents/environments/index.js';
import type { Issue } from '@domain/agents/environments/index.js';

/** Validate an environment body without writing anything. */
export function validateEnvironmentBody(
  name: string, body: unknown,
): { ok: boolean; errors: Issue[]; warnings: Issue[] } {
  const { errors, warnings } = validateEnvironment(name, body, fsRefResolver());
  return { ok: errors.length === 0, errors, warnings };
}

/** Create or replace one environment, then reload the registry so the next turn already runs it
 *  (the directory watcher would get there too; a second load is idempotent). */
export function saveEnvironmentBody(
  name: string, body: unknown, baseHash: string | null,
): { changed: boolean; sha256: string; warnings: Issue[] } {
  const result = saveEnvironment(ENVIRONMENTS_DIR, { name, body, baseHash }, fsRefResolver());
  if (result.changed) loadEnvironments();
  return { changed: result.changed, sha256: result.sha256, warnings: result.warnings };
}

export function removeEnvironmentFile(name: string): { removed: boolean } {
  const result = removeEnvironment(ENVIRONMENTS_DIR, name);
  if (result.removed) loadEnvironments();
  return { removed: result.removed };
}
