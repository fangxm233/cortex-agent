// input:  hook registry dir, template dir, hook scripts dir
// output: HooksOverview with per-entry derived mount and edit state
// pos:    Hermetic hooks.list read model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR, HOOKS_DIR } from '@core/paths.js';
import { loadMountedHooks, type MountedHook } from '@store/hook-registry.js';
import { hookAppliesAt, hookMountTargets, legalResultModes } from '@domain/hooks/hook-view.js';
import type {
  UiServiceDeps,
  HooksListParams,
  HooksOverview,
  HookDetail,
  HookScriptInfo,
  HookRunInfo,
  HookScopeInfo,
} from '../types.js';

function runInfo(hook: MountedHook): HookRunInfo {
  if (hook.kind === 'template') {
    // Template hooks are raw commands with a millisecond timeout; only the command is comparable.
    return { script: null, command: hook.run.command, timeoutSec: null };
  }
  const run = hook.entry.run;
  return {
    script: run.script ?? null,
    command: run.command ?? null,
    timeoutSec: run.timeout ?? null,
  };
}

function scopeInfo(hook: MountedHook): HookScopeInfo | null {
  if (hook.kind === 'template') return null;
  const scope = hook.entry.scope;
  if (!scope) return null;
  return {
    backends: scope.backends ?? null,
    requiresTool: scope.requiresTool ?? null,
  };
}

/** Present only when the declaration names a script we can resolve on disk. */
function scriptExists(hook: MountedHook, scriptsDir: string): boolean | null {
  if (hook.kind === 'template') return null;
  const script = hook.entry.run.script;
  if (script === undefined) return null;
  return fs.existsSync(path.join(scriptsDir, script));
}

function toDetail(hook: MountedHook, order: number, scriptsDir: string): HookDetail {
  const matcher = hook.kind === 'registry' ? hook.entry.matcher : undefined;
  const isTemplate = hook.kind === 'template';
  return {
    id: hook.id,
    event: hook.event,
    matcher: typeof matcher === 'string' ? matcher : null,
    matcherFilters: typeof matcher === 'object' && matcher !== null ? matcher : null,
    run: runInfo(hook),
    scope: scopeInfo(hook),
    blocking: !isTemplate ? hook.entry.blocking ?? null : null,
    result: !isTemplate ? hook.entry.result ?? null : null,
    enabled: hook.enabled,
    source: hook.source,
    version: !isTemplate ? hook.entry.version ?? null : null,
    fileName: !isTemplate ? path.basename(hook.filePath) : null,
    order,
    // Template hooks are dispatched through the same bus as cortex:thread.* registry entries, so
    // the derived view is computed from a synthetic entry carrying just the event.
    mountsOn: hookMountTargets(isTemplate ? ({ event: hook.event } as never) : hook.entry),
    legalResults: legalResultModes(hook.event),
    appliesAt: hookAppliesAt(hook.event),
    scriptExists: scriptExists(hook, scriptsDir),
    editable: hook.source === 'user',
    template: isTemplate ? hook.template : null,
    phase: isTemplate ? hook.phase : null,
  };
}

/**
 * Whether a hook references a script. `run.script` is the declared form, but template hooks and
 * command-based entries invoke scripts through a shell string instead (`node ~/.cortex/hooks/x.mjs`),
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

function listScripts(scriptsDir: string, hooks: HookDetail[]): HookScriptInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(scriptsDir).filter((file) => file.endsWith('.mjs')).sort();
  } catch {
    return [];
  }
  return names.map((name) => ({
    name,
    usedBy: hooks.filter((hook) => referencesScript(hook, name)).map((hook) => hook.id),
  }));
}

/**
 * Build the hooks overview from explicit directories. Pure over its arguments (no global paths) so
 * it is hermetically testable against fixtures, mirroring `readConfigSnapshot`.
 */
export function readHooksOverview(
  registryDir: string,
  templateDir: string,
  scriptsDir: string,
): HooksOverview {
  const hooks = loadMountedHooks(registryDir, templateDir).map((hook, index) =>
    toDetail(hook, index, scriptsDir),
  );
  return { hooks, scripts: listScripts(scriptsDir, hooks), hooksDir: scriptsDir };
}

export async function handleHooksList(
  _deps: UiServiceDeps,
  _params: HooksListParams,
): Promise<HooksOverview> {
  return readHooksOverview(
    path.join(CONFIG_DIR, 'hooks'),
    path.join(CONFIG_DIR, 'thread-templates', 'templates'),
    HOOKS_DIR,
  );
}
