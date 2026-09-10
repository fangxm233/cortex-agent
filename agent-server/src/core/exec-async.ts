// input:  child_process.execFile, timeouts, cwd/env and buffer limits
// output: runFile/runShell results that resolve instead of throwing
// pos:    事件循环友好的异步子进程执行器（替代热路径上的 execSync/execFileSync）
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { execFile } from 'node:child_process';

/** Normalized outcome of a child process run. Non-zero exits and timeouts are values, not throws. */
export interface ExecResult {
  /** Exit code 0 — the only case callers should treat as success. */
  ok: boolean;
  /** Exit code, or null when the process was killed (timeout/signal) or failed to spawn. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the shared timeout elapsed and the child was killed. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Spawn-level failure (ENOENT, EACCES, …). Absent for ordinary non-zero exits. */
  error?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Text piped to the child's stdin, which is then closed. Omitted → stdin is closed empty. */
  stdin?: string;
}

/** execFile's own default; kept explicit so a caller can raise it for git blame-sized output. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

function finish(
  resolve: (result: ExecResult) => void,
  error: (Error & { code?: number | string | null; signal?: NodeJS.Signals | null; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
  timeoutMs: number | undefined,
): void {
  const code = error && typeof error.code === 'number' ? error.code : error ? null : 0;
  const signal = error?.signal ?? null;
  // Node reports a timed-out child as killed with a SIGTERM signal; a missing binary arrives
  // as a string errno code with no signal at all. Both land here as code=null.
  const timedOut = Boolean(error) && (error?.killed === true || signal === 'SIGTERM') && timeoutMs !== undefined;
  resolve({
    ok: code === 0,
    code,
    signal,
    timedOut,
    stdout,
    stderr,
    ...(error && typeof error.code === 'string' ? { error: error.message } : {}),
  });
}

/** Run a binary with an argument array — no shell, so no quoting surface. */
export function runFile(
  file: string,
  args: readonly string[] = [],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => finish(resolve, error as never, stdout, stderr, opts.timeoutMs),
    );
    // Always close stdin: a child that reads it (e.g. `git cat-file --batch-check`) must not wait
    // on a pipe nobody writes to.
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}

/** Run a command line through the platform shell — the async equivalent of `execSync(command)`. */
export function runShell(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const shell = process.platform === 'win32'
    ? (process.env.ComSpec ?? 'cmd.exe')
    : '/bin/sh';
  const flag = process.platform === 'win32' ? '/c' : '-c';
  return runFile(shell, [flag, command], opts);
}
