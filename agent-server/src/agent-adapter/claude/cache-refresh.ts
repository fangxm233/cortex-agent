import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { EngineSpec } from '../types.js';
import { claudeProcessLaunch, launchFromSpec } from './session-options.js';
import { computeTranscriptPath, readRestoredSessionCost } from './transcript-path.js';

// A keep-warm refresh: one request on a fork of an idle session, so the session's one-hour prompt
// cache is read (which restarts its clock) without the session's own transcript changing. The fork
// resumes the transcript, sends one short message, persists nothing, and is gone after its result.

export const CACHE_REFRESH_PROMPT = '[Cortex cache refresh] Reply with exactly: ok';
export const CACHE_REFRESH_TIMEOUT_MS = 90_000;
/** How long a fork may take to exit once its stdin closes, before it is killed. */
const EXIT_GRACE_MS = 10_000;

export interface CacheRefreshLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  sessionId: string;
  transcriptPath: string;
}

export interface CacheRefreshUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CacheRefreshResult {
  usage: CacheRefreshUsage;
  model: string | null;
  /** This one request: the fork's total minus the history total it restored. */
  costUsd: number;
  durationMs: number;
}

/** The slice of a child process the refresh drives; `child_process.spawn` returns one. */
export interface CacheRefreshChild {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null) => void): this;
}

export type CacheRefreshSpawn = (
  command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv },
) => CacheRefreshChild;

export interface CacheRefreshDeps {
  spawn?: CacheRefreshSpawn;
  timeoutMs?: number;
  now?: () => number;
}

const FORK_FLAGS = ['--fork-session', '--no-session-persistence', '--max-turns', '1'];

/** The launch's session identity (`--session-id X` or `--resume X`) turned into a one-turn fork of
 *  X that persists nothing. Throws when the argv does not name X. */
export function forkRefreshArgs(args: readonly string[], sessionId: string): string[] {
  const at = args.findIndex((arg, i) =>
    (arg === '--session-id' || arg === '--resume') && args[i + 1] === sessionId);
  if (at === -1) throw new Error(`launch does not name session ${sessionId}`);
  return [...args.slice(0, at), '--resume', sessionId, ...FORK_FLAGS, ...args.slice(at + 2)];
}

/**
 * The fork's command line: the launch the session's next turn would spawn, resumed, without
 * hooks. Hooks run Cortex scripts against the session's identity and add nothing to the cached
 * prefix, which is the system prompt, the tools and the transcript.
 */
export function cacheRefreshLaunch(spec: EngineSpec): CacheRefreshLaunch {
  const sessionId = spec.resume.backendSessionId;
  if (!sessionId) throw new Error('cache refresh needs a backend session to resume');
  const launch = launchFromSpec(spec);
  const options = { ...launch.options, disableHooks: true };
  const { args, env } = claudeProcessLaunch({
    channel: launch.channel, sessionId, needsResume: true, options,
  });
  return {
    command: options.cliPath ?? 'claude',
    args: forkRefreshArgs(args, sessionId),
    env,
    cwd: options.cwd,
    sessionId,
    transcriptPath: computeTranscriptPath(options.cwd, sessionId),
  };
}

/** A resumed fork's `total_cost_usd` carries the session's restored history; this is the rest. */
export function refreshCost(totalCostUsd: unknown, restoredUsd: number): number {
  if (typeof totalCostUsd !== 'number' || !Number.isFinite(totalCostUsd)) return 0;
  return Math.max(0, totalCostUsd - restoredUsd);
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usageOf(usage: Record<string, unknown> | undefined): CacheRefreshUsage {
  return {
    inputTokens: tokens(usage?.input_tokens),
    outputTokens: tokens(usage?.output_tokens),
    cacheReadTokens: tokens(usage?.cache_read_input_tokens),
    cacheWriteTokens: tokens(usage?.cache_creation_input_tokens),
  };
}

interface ForkOutput {
  result: Record<string, any>;
  model: string | null;
}

function parseRecord(line: string): Record<string, any> | null {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/** Once the result is in, close stdin so the CLI exits; kill it if it lingers. */
function release(child: CacheRefreshChild): void {
  child.stdin?.end();
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, EXIT_GRACE_MS);
  timer.unref?.();
  child.on('close', () => clearTimeout(timer));
}

/** The fork's `result` record and the model that answered, or a rejection on timeout, a spawn
 *  error, or an exit before the result. A timeout kills the fork. */
function readForkResult(child: CacheRefreshChild, timeoutMs: number): Promise<ForkOutput> {
  return new Promise((resolve, reject) => {
    let model: string | null = null;
    let stderr = '';
    let done = false;
    const finish = (error: Error | null, result?: Record<string, any>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ result: result!, model });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`no result within ${timeoutMs}ms`));
    }, timeoutMs);
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const record = parseRecord(line);
      if (record?.type === 'assistant') model ??= record.message?.model ?? null;
      if (record?.type === 'result') finish(null, record);
    });
    child.stderr?.on('data', (data) => { stderr = (stderr + String(data)).slice(-500); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(new Error(`exited ${code} before a result: ${stderr.trim()}`)));
  });
}

function checkResult(result: Record<string, any>): void {
  // `--max-turns 1` ends a reply that reached for a tool as an error, but its request still ran.
  if (result.is_error !== true || result.subtype === 'error_max_turns') return;
  throw new Error(`refresh failed: ${String(result.result ?? result.subtype).slice(0, 300)}`);
}

function writePrompt(child: CacheRefreshChild): void {
  // A fork that dies at once fails the write with EPIPE; its exit already rejects the refresh.
  child.stdin!.on('error', () => {});
  const message = { type: 'user', message: { role: 'user', content: CACHE_REFRESH_PROMPT } };
  child.stdin!.write(JSON.stringify(message) + '\n');
}

/** Run one refresh fork to its result. */
export async function runCacheRefresh(
  launch: CacheRefreshLaunch,
  deps: CacheRefreshDeps = {},
): Promise<CacheRefreshResult> {
  const now = deps.now ?? Date.now;
  const restoredUsd = readRestoredSessionCost(launch.transcriptPath, launch.sessionId);
  const started = now();
  const child = (deps.spawn ?? defaultSpawn)(launch.command, launch.args, { cwd: launch.cwd, env: launch.env });
  const output = readForkResult(child, deps.timeoutMs ?? CACHE_REFRESH_TIMEOUT_MS);
  writePrompt(child);
  const { result, model } = await output;
  release(child);
  checkResult(result);
  return {
    usage: usageOf(result.usage),
    model,
    costUsd: refreshCost(result.total_cost_usd, restoredUsd),
    durationMs: now() - started,
  };
}

function defaultSpawn(
  command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv },
): CacheRefreshChild {
  return spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
}
