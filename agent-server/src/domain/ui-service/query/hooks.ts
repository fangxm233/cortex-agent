import * as path from 'node:path';
import { listLayeredFiles } from '@core/builtin-layer.js';
import { defaultHookScriptDirs, resolveHookScript, type HookScriptDirs } from '@core/hook-scripts.js';
import { defaultHookRegistryDirs, loadMountedHooks, type HookRegistryDirs, type MountedHook } from '@store/hook-registry.js';
import { existsSync } from 'node:fs';
import { hookAppliesAt, hookMountTargets, legalResultModes } from '@domain/hooks/hook-view.js';
import type {
  UiServiceDeps,
  HooksOverview,
  HookDetail,
  HookScriptInfo,
  HookRunInfo,
  HookScopeInfo,
  QueryParams,
} from '../types.js';

function runInfo(hook: MountedHook): HookRunInfo {
  const run = hook.entry.run;
  return {
    script: run.script ?? null,
    command: run.command ?? null,
    timeoutSec: run.timeout ?? null,
  };
}

function scopeInfo(hook: MountedHook): HookScopeInfo | null {
  const scope = hook.entry.scope;
  if (!scope) return null;
  return {
    backends: scope.backends ?? null,
    requiresTool: scope.requiresTool ?? null,
  };
}

/** Present only when the declaration names a script we can resolve on disk. */
function scriptExists(hook: MountedHook, scriptDirs: HookScriptDirs): boolean | null {
  const script = hook.entry.run.script;
  if (script === undefined) return null;
  return existsSync(resolveHookScript(script, scriptDirs).path);
}

function toDetail(hook: MountedHook, order: number, scriptDirs: HookScriptDirs): HookDetail {
  const matcher = hook.entry.matcher;
  return {
    id: hook.id,
    event: hook.event,
    matcher: typeof matcher === 'string' ? matcher : null,
    matcherFilters: typeof matcher === 'object' && matcher !== null ? matcher : null,
    run: runInfo(hook),
    scope: scopeInfo(hook),
    blocking: hook.entry.blocking ?? null,
    result: hook.entry.result ?? null,
    enabled: hook.enabled,
    source: hook.source,
    overridden: hook.overridden,
    version: hook.entry.version ?? null,
    fileName: path.basename(hook.filePath),
    order,
    mountsOn: hookMountTargets(hook.entry),
    legalResults: legalResultModes(hook.event),
    appliesAt: hookAppliesAt(hook.event),
    scriptExists: scriptExists(hook, scriptDirs),
    editable: hook.source === 'user',
    template: null,
    phase: null,
  };
}

/**
 * Whether a hook references a script. `run.script` is the declared form, but command-based entries
 * invoke scripts through a shell string instead (`node ~/.cortex/hooks/x.mjs`),
 * so the command is scanned too — matching whole path segments, not substrings, so `task.mjs` is
 * not considered used by a command that runs `post-task.mjs`. Reporting a live script as unused
 * would invite deleting it.
 */
function referencesScript(hook: HookDetail, name: string): boolean {
  if (hook.run.script === name) return true;
  const command = hook.run.command;
  if (!command) return false;
  return command
    .split(/\s+/)
    .some((token) => path.posix.basename(token.replace(/['"]/g, '')) === name);
}

/** The scripts of both layers: shipped, the user's copies of shipped ones, and the user's own. */
function listScripts(scriptDirs: HookScriptDirs, hooks: HookDetail[]): HookScriptInfo[] {
  return listLayeredFiles(scriptDirs.builtin, scriptDirs.user, '.mjs').map((file) => ({
    name: file.name,
    usedBy: hooks.filter((hook) => referencesScript(hook, file.name)).map((hook) => hook.id),
    origin: file.origin,
  }));
}

/**
 * Build the hooks overview from explicit directories. Pure over its arguments (no global paths) so
 * it is hermetically testable against fixtures, mirroring `readConfigSnapshot`.
 */
export function readHooksOverview(registryDirs: HookRegistryDirs, scriptDirs: HookScriptDirs): HooksOverview {
  const hooks = loadMountedHooks(registryDirs).map((hook, index) =>
    toDetail(hook, index, scriptDirs),
  );
  return { hooks, scripts: listScripts(scriptDirs, hooks), hooksDir: scriptDirs.user };
}

export async function handleHooksList(
  _deps: UiServiceDeps,
  _params: QueryParams<'hooks.list'>,
): Promise<HooksOverview> {
  return readHooksOverview(defaultHookRegistryDirs(), defaultHookScriptDirs());
}
