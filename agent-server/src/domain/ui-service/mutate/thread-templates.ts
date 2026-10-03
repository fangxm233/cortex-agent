import { saveEntity, removeEntity, readRawRegistry } from '@domain/threads/template-writer.js';
import {
  validateEntity,
  withCandidate,
  type RawRegistry,
} from '@domain/threads/template-validate.js';
import {
  CONFIG_TEMPLATES_DIR,
  loaderRefResolver,
  loadConfig,
} from '@domain/threads/template-loader.js';
import type {
  UiServiceDeps,
  Result,
  ThreadTemplatesValidateArgs,
  ThreadTemplatesValidateReturn,
  ThreadTemplatesSaveArgs,
  ThreadTemplatesSaveReturn,
  ThreadTemplatesRemoveArgs,
  ThreadTemplatesRemoveReturn,
} from '../types.js';
import { toErr } from './errors.js';
import { removeEnvironmentFile, saveEnvironmentBody, validateEnvironmentBody } from './environments.js';

function currentRegistry(): RawRegistry {
  return readRawRegistry(CONFIG_TEMPLATES_DIR);
}

export async function handleThreadTemplatesValidate(
  _deps: UiServiceDeps,
  args: ThreadTemplatesValidateArgs,
): Promise<Result<ThreadTemplatesValidateReturn>> {
  try {
    // Agents are execution environments (config/environments/); only templates and shells live
    // under thread-templates.
    if (args.kind === 'agent') return { ok: true, data: validateEnvironmentBody(args.name, args.body) };
    // Judge the candidate by the world it would produce, not the one it replaces.
    const registry = withCandidate(currentRegistry(), args.kind, args.name, args.body);
    const { errors, warnings } = validateEntity(
      args.kind,
      args.name,
      args.body,
      registry,
      loaderRefResolver(),
    );
    return { ok: true, data: { ok: errors.length === 0, errors, warnings } };
  } catch (error) {
    return toErr(error);
  }
}

export async function handleThreadTemplatesSave(
  _deps: UiServiceDeps,
  args: ThreadTemplatesSaveArgs,
): Promise<Result<ThreadTemplatesSaveReturn>> {
  try {
    if (args.kind === 'agent') {
      return { ok: true, data: saveEnvironmentBody(args.name, args.body, args.baseHash ?? null) };
    }
    const result = saveEntity(
      CONFIG_TEMPLATES_DIR,
      { kind: args.kind, name: args.name, body: args.body, baseHash: args.baseHash ?? null },
      loaderRefResolver(),
    );
    // Reload now rather than waiting on the 300ms debounced watcher, so the response the UI gets
    // back already reflects a registry that has accepted the change. The watcher still fires; a
    // second load is idempotent.
    if (result.changed) loadConfig();
    return {
      ok: true,
      data: { changed: result.changed, sha256: result.sha256, warnings: result.warnings },
    };
  } catch (error) {
    return toErr(error);
  }
}

export async function handleThreadTemplatesRemove(
  _deps: UiServiceDeps,
  args: ThreadTemplatesRemoveArgs,
): Promise<Result<ThreadTemplatesRemoveReturn>> {
  try {
    if (args.kind === 'agent') return { ok: true, data: removeEnvironmentFile(args.name) };
    const result = removeEntity(CONFIG_TEMPLATES_DIR, args.kind, args.name);
    if (result.removed) loadConfig();
    return { ok: true, data: { removed: result.removed } };
  } catch (error) {
    return toErr(error);
  }
}
