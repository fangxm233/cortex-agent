import type { HookEntry } from '../store/hook-registry.js';
import { runHookProcess } from './hook-exec.js';
import { defaultHookScriptDirs, hookScriptArgs, type HookScriptDirs } from './hook-scripts.js';
import { createLogger } from './log.js';

export type HookSpec = {
  id: string;
  command: string;
  args?: string[];
  timeoutMs: number;
  result?: 'stdout-as-prompt' | 'none';
};

export type HookEmitResult = {
  id: string;
  result?: unknown;
  error?: string;
  stderr?: string;
};

/** Registry entries without run.timeout use a 30-second process limit. */
const DEFAULT_REGISTRY_TIMEOUT_MS = 30_000;
const log = createLogger('hook-bus');

let registryEntries: readonly HookEntry[] = [];
let scriptDirs: HookScriptDirs | null = null;

function isObjectMatcher(
  value: HookEntry['matcher'],
): value is Record<string, string | number | boolean | null> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesPayload(
  matcher: HookEntry['matcher'],
  payload: Record<string, unknown>,
): boolean {
  if (matcher === undefined) return true;
  if (!isObjectMatcher(matcher)) return false;
  return Object.entries(matcher).every(
    ([key, value]) => Object.hasOwn(payload, key) && payload[key] === value,
  );
}

function registryHook(entry: HookEntry, defaultTimeoutMs: number): HookSpec {
  const args = entry.run.script === undefined
    ? undefined
    : hookScriptArgs(entry.run.script, scriptDirs ?? defaultHookScriptDirs());
  return {
    id: entry.id,
    command: args === undefined ? entry.run.command : 'node',
    args,
    timeoutMs: entry.run.timeout === undefined
      ? defaultTimeoutMs
      : entry.run.timeout * 1_000,
    result: entry.result,
  };
}

function matchingRegistryHooks(
  event: `cortex:${string}`,
  payload: Record<string, unknown>,
  defaultTimeoutMs: number,
): HookSpec[] {
  return registryEntries
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => entry.event === event)
    .filter((entry) => matchesPayload(entry.matcher, payload))
    .map((entry) => registryHook(entry, defaultTimeoutMs));
}

function failure(id: string, error: unknown): HookEmitResult {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`Hook ${id} failed: ${message}`);
  return { id, error: message };
}

function parsedResult(hook: HookSpec, stdout: string): HookEmitResult {
  return hook.result === 'stdout-as-prompt' ? { id: hook.id, result: stdout.trim() } : { id: hook.id };
}

function interpretResult(hook: HookSpec, stdout: string, stderr: string): HookEmitResult {
  const result = parsedResult(hook, stdout);
  return stderr ? { ...result, stderr } : result;
}

async function executeHook(
  hook: HookSpec,
  stdinPayload: string,
  env?: NodeJS.ProcessEnv,
): Promise<HookEmitResult> {
  try {
    const output = await runHookProcess({
      command: hook.command,
      args: hook.args,
      timeoutMs: hook.timeoutMs,
      stdinPayload,
      env,
      label: hook.id,
    });
    if (output.error) return failure(hook.id, output.error);
    return interpretResult(hook, output.stdout, output.stderr);
  } catch (error) {
    return failure(hook.id, error);
  }
}

export function initHookBus(opts: {
  entries: readonly HookEntry[];
  /** Test seam; production resolves scripts through the user and shipped hooks dirs. */
  scriptDirs?: HookScriptDirs;
}): void {
  registryEntries = [...opts.entries];
  scriptDirs = opts.scriptDirs ?? null;
}

function serializePayload(payload: Record<string, unknown>): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new TypeError('Hook payload is not JSON-serializable');
  return serialized;
}

export async function emitCortexEvent(
  event: `cortex:${string}`,
  payload: Record<string, unknown>,
  opts?: {
    scopedHooks?: HookSpec[];
    env?: NodeJS.ProcessEnv;
    defaultTimeoutMs?: number;
  },
): Promise<HookEmitResult[]> {
  const hooks = [
    ...matchingRegistryHooks(event, payload, opts?.defaultTimeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS),
    ...(opts?.scopedHooks ?? []),
  ];
  if (hooks.length === 0) return [];
  let stdinPayload: string;
  try {
    stdinPayload = serializePayload(payload);
  } catch (error) {
    return hooks.map((hook) => failure(hook.id, error));
  }
  const results: HookEmitResult[] = [];
  for (const hook of hooks) {
    results.push(await executeHook(hook, stdinPayload, opts?.env));
  }
  return results;
}
