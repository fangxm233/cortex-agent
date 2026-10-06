import { t } from '@core/i18n.js';
import {
  ENVIRONMENTS_DIR,
  FALLBACK_ENVIRONMENT,
  fsRefResolver,
  loadEnvironments,
  removeEnvironment,
  saveEnvironment,
  validateEnvironment,
} from '@domain/agents/environments/index.js';
import type { Issue } from '@domain/agents/environments/index.js';
import type {
  EnvironmentsDeleteReturn,
  EnvironmentsSaveReturn,
  EnvironmentsValidateReturn,
  Result,
  UiServiceDeps,
  MutateArgs,
} from '../types.js';
import { fail, toErr } from './errors.js';

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
  name: string, body: unknown, baseHash: string | null, dir: string = ENVIRONMENTS_DIR,
): { changed: boolean; sha256: string; warnings: Issue[] } {
  const result = saveEnvironment(dir, { name, body, baseHash }, fsRefResolver());
  if (result.changed) loadEnvironments(dir);
  return { changed: result.changed, sha256: result.sha256, warnings: result.warnings };
}

/** Delete one environment. The fallback environment is what every conversation resolves to when
 *  nothing names another, so it is never deleted. */
export function removeEnvironmentFile(name: string, dir: string = ENVIRONMENTS_DIR): { removed: boolean } {
  if (name === FALLBACK_ENVIRONMENT) {
    throw fail('invalid-args', t('ux.env.mainUndeletable', { name }));
  }
  const result = removeEnvironment(dir, name);
  if (result.removed) loadEnvironments(dir);
  return { removed: result.removed };
}

export async function handleEnvironmentsValidate(
  _deps: UiServiceDeps,
  args: MutateArgs<'environments.validate'>,
): Promise<Result<EnvironmentsValidateReturn>> {
  try {
    return { ok: true, data: validateEnvironmentBody(args.name, args.body) };
  } catch (error) {
    return toErr(error);
  }
}

export async function handleEnvironmentsSave(
  _deps: UiServiceDeps,
  args: MutateArgs<'environments.save'>,
): Promise<Result<EnvironmentsSaveReturn>> {
  try {
    return { ok: true, data: saveEnvironmentBody(args.name, args.body, args.baseHash ?? null) };
  } catch (error) {
    return toErr(error);
  }
}

export async function handleEnvironmentsDelete(
  _deps: UiServiceDeps,
  args: MutateArgs<'environments.delete'>,
): Promise<Result<EnvironmentsDeleteReturn>> {
  try {
    return { ok: true, data: removeEnvironmentFile(args.name) };
  } catch (error) {
    return toErr(error);
  }
}
