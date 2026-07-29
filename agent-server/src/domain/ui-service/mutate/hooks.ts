// input:  UiServiceDeps + flattened hook draft / id arguments
// output: create/update/setEnabled/remove/test handlers → Ok | Err
// pos:    mutate handlers for the 'hooks.*' operations
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'node:path';
import { HOOKS_DIR } from '@core/paths.js';
import { runHookProcess, type HookProcessOptions } from '@core/hook-exec.js';
import { loadMountedHooks, type MountedHook } from '@store/hook-registry.js';
import {
  createHookEntry,
  removeHookEntry,
  setHookEnabled,
  updateHookEntry,
  type HookEntryDraft,
} from '@store/hook-writer.js';
import type {
  UiServiceDeps,
  Result,
  HookDraftInput,
  HooksCreateArgs,
  HooksCreateReturn,
  HooksUpdateArgs,
  HooksUpdateReturn,
  HooksSetEnabledArgs,
  HooksSetEnabledReturn,
  HooksRemoveArgs,
  HooksRemoveReturn,
  HooksTestArgs,
  HooksTestReturn,
} from '../types.js';

/**
 * A UI-triggered test run must not be able to park a request for the 30-minute TTL of a blocking
 * webhook hook, so the declared timeout is capped regardless of what the declaration asks for.
 */
const TEST_TIMEOUT_CAP_MS = 15_000;

/**
 * Rebuild the nested declaration shape from the flat form fields. `blocking` is deliberately not
 * accepted: it is wired to the two shipped webhook hooks and has no meaning for a hand-made entry.
 */
export function hookDraftFromArgs(args: HookDraftInput): HookEntryDraft {
  const run: Record<string, unknown> = {};
  if (args.script !== undefined) run.script = args.script;
  if (args.command !== undefined) run.command = args.command;
  if (args.timeoutSec !== undefined) run.timeout = args.timeoutSec;

  const draft: HookEntryDraft = { event: args.event, run: run as HookEntryDraft['run'] };
  // A regex matcher and a filter object are mutually exclusive; the regex wins if both arrive.
  if (args.matcher !== undefined) draft.matcher = args.matcher;
  else if (args.matcherFilters !== undefined) draft.matcher = args.matcherFilters;

  if (args.backends !== undefined || args.requiresTool !== undefined) {
    draft.scope = {};
    if (args.backends !== undefined) draft.scope.backends = args.backends;
    if (args.requiresTool !== undefined) draft.scope.requiresTool = args.requiresTool;
  }
  if (args.result !== undefined) draft.result = args.result;
  if (args.enabled !== undefined) draft.enabled = args.enabled;
  return draft;
}

/** Writer errors carry `code`; anything else is a genuine internal failure. */
function toErr(error: unknown): Result<never> {
  const code = (error as { code?: unknown })?.code;
  return {
    ok: false,
    code: code === 'not-found' || code === 'invalid-args' ? code : 'internal',
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function handleHooksCreate(
  _deps: UiServiceDeps,
  args: HooksCreateArgs,
): Promise<Result<HooksCreateReturn>> {
  try {
    const { id, filePath } = createHookEntry(undefined, {
      id: args.id,
      ...hookDraftFromArgs(args),
    });
    return { ok: true, data: { id, fileName: path.basename(filePath) } };
  } catch (error) {
    return toErr(error);
  }
}

export async function handleHooksUpdate(
  _deps: UiServiceDeps,
  args: HooksUpdateArgs,
): Promise<Result<HooksUpdateReturn>> {
  try {
    const { changed } = updateHookEntry(undefined, args.id, hookDraftFromArgs(args));
    return { ok: true, data: { changed } };
  } catch (error) {
    return toErr(error);
  }
}

export async function handleHooksSetEnabled(
  _deps: UiServiceDeps,
  args: HooksSetEnabledArgs,
): Promise<Result<HooksSetEnabledReturn>> {
  try {
    const { changed, warning } = setHookEnabled(undefined, args.id, args.enabled);
    return { ok: true, data: { changed, warning: warning ?? null } };
  } catch (error) {
    return toErr(error);
  }
}

export async function handleHooksRemove(
  _deps: UiServiceDeps,
  args: HooksRemoveArgs,
): Promise<Result<HooksRemoveReturn>> {
  try {
    return { ok: true, data: removeHookEntry(undefined, args.id) };
  } catch (error) {
    return toErr(error);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Mirrors the cortex-hook CLI's process options, with the timeout clamped for UI-triggered runs. */
export function testProcessOptions(
  hook: MountedHook,
  hooksDir: string,
  stdinPayload: string,
): HookProcessOptions {
  if (hook.kind === 'template') {
    return {
      command: hook.run.command,
      args: hook.run.args,
      timeoutMs: Math.min(hook.run.timeout ?? 30_000, TEST_TIMEOUT_CAP_MS),
      stdinPayload,
      label: hook.id,
    };
  }
  const run = hook.entry.run;
  const command = run.script === undefined
    ? run.command
    : `node ${shellQuote(path.join(hooksDir, run.script))}`;
  return {
    command,
    timeoutMs: Math.min((run.timeout ?? 30) * 1_000, TEST_TIMEOUT_CAP_MS),
    stdinPayload,
    label: hook.id,
  };
}

export async function handleHooksTest(
  _deps: UiServiceDeps,
  args: HooksTestArgs,
): Promise<Result<HooksTestReturn>> {
  const hook = loadMountedHooks().find((candidate) => candidate.id === args.id);
  if (!hook) return { ok: false, code: 'not-found', message: `Unknown hook id: '${args.id}'` };
  try {
    const result = await runHookProcess(testProcessOptions(hook, HOOKS_DIR, args.payload));
    return {
      ok: true,
      data: {
        ok: result.exitCode === 0 && !result.error,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error ?? null,
      },
    };
  } catch (error) {
    return toErr(error);
  }
}
