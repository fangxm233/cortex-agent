import { runFile, type ExecResult } from '@core/exec-async.js';

// One tiny request through Claude Code itself. It opens Claude's five-hour subscription window, and
// on the way Claude Code refreshes its own login under its own lock, which Cortex must not do
// behind its back.

export const WINDOW_WARMUP_TIMEOUT_MS = 120_000;
const WARMUP_PROMPT = 'ok';

/** No tools, no MCP servers, no session file. The prompt goes on stdin because `--tools` takes a
 *  variable number of values and would swallow a trailing positional prompt. */
export const WINDOW_WARMUP_ARGS: readonly string[] = [
  '-p', '--output-format', 'json', '--model', 'haiku', '--max-turns', '1',
  '--no-session-persistence', '--strict-mcp-config',
  '--system-prompt', 'Reply with exactly: ok', '--tools', '',
];

export interface WindowWarmupLaunch {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type WindowWarmupRunner = typeof runFile;

function parseResult(stdout: string): Record<string, unknown> | null {
  try {
    const record = JSON.parse(stdout.trim());
    return record && typeof record === 'object' && record.type === 'result' ? record : null;
  } catch {
    return null;
  }
}

function failureText(result: ExecResult, output: Record<string, unknown> | null): string {
  if (result.timedOut) return `timed out after ${WINDOW_WARMUP_TIMEOUT_MS}ms`;
  const text = typeof output?.result === 'string' ? output.result : result.stderr.trim() || result.error;
  return (text || `exit ${result.code}`).slice(-300);
}

/** Resolves once Claude answered; rejects with the CLI's own error text otherwise. */
export async function runWindowWarmup(
  launch: WindowWarmupLaunch,
  run: WindowWarmupRunner = runFile,
): Promise<void> {
  const result = await run(launch.command, WINDOW_WARMUP_ARGS, {
    cwd: launch.cwd, env: launch.env, timeoutMs: WINDOW_WARMUP_TIMEOUT_MS, stdin: WARMUP_PROMPT,
  });
  const output = parseResult(result.stdout);
  if (result.ok && output && output.is_error !== true) return;
  throw new Error(`Claude warm-up failed: ${failureText(result, output)}`);
}
