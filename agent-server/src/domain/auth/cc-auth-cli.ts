// input:  Claude CLI, child-process streams, abort signals
// output: scrubbed Claude auth login/status/logout operations
// pos:    Claude-owned authentication CLI adapter
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_CHARS = 64 * 1024;
const AUTH_PROMPT = 'Paste code here if prompted >';
const AUTH_URL_PATTERN = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\x1b]+/;
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1B\][^\x07]*(?:\x07|\x1B\\)/g;
const AUTH_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
] as const;

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
}

export class ClaudeAuthCliError extends Error {
  readonly name = 'ClaudeAuthCliError';

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type ClaudeAuthSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

export interface ClaudeAuthCliDependencies {
  executable?: string;
  spawn?: ClaudeAuthSpawn;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeAuthLoginOptions {
  signal?: AbortSignal;
  onAuthorization(url: string): Promise<string>;
  onCodeSubmitted?: () => void;
}

interface CommandOptions {
  signal?: AbortSignal;
  failureCode: string;
  onStop?: (error: Error) => void;
}

function cliError(code: string, message: string): ClaudeAuthCliError {
  return new ClaudeAuthCliError(code, message);
}

export function buildClaudeAuthEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { BROWSER: 'true' };
  for (const key of AUTH_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function spawnAuth(
  args: string[],
  dependencies: ClaudeAuthCliDependencies,
): ChildProcessWithoutNullStreams {
  const spawn = dependencies.spawn ?? nodeSpawn;
  return spawn(dependencies.executable ?? 'claude', args, {
    env: buildClaudeAuthEnv(dependencies.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function commandError(code: string): ClaudeAuthCliError {
  const messages: Record<string, string> = {
    claude_auth_login_failed: 'Claude authentication login failed.',
    claude_auth_logout_failed: 'Claude authentication logout failed.',
    claude_auth_status_failed: 'Claude authentication status check failed.',
  };
  return cliError(code, messages[code] ?? 'Claude authentication command failed.');
}

class ExitWaiter {
  private settled = false;
  private readonly timer: NodeJS.Timeout;
  private readonly onAbort = () => this.stop(cliError(
    'claude_auth_cancelled', 'Claude authentication was cancelled.',
  ));

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    dependencies: ClaudeAuthCliDependencies,
    private readonly options: CommandOptions,
    private readonly resolve: () => void,
    private readonly reject: (error: Error) => void,
  ) {
    this.timer = setTimeout(
      () => this.stop(cliError('claude_auth_timeout', 'Claude authentication timed out.')),
      dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    child.once('error', () => this.finish(commandError(options.failureCode)));
    child.once('close', code => this.finish(code === 0 ? undefined : commandError(options.failureCode)));
    if (options.signal?.aborted) this.onAbort();
  }

  private cleanup(): void {
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
  }

  private finish(error?: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    error ? this.reject(error) : this.resolve();
  }

  private stop(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.options.onStop?.(error);
    try { this.child.kill('SIGTERM'); } catch {}
    this.reject(error);
  }
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  dependencies: ClaudeAuthCliDependencies,
  options: CommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    new ExitWaiter(child, dependencies, options, resolve, reject);
  });
}

function appendBounded(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(-MAX_OUTPUT_CHARS);
}

function stripTerminal(value: string): string {
  return value.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '');
}

function normalizeCode(value: string): string | null {
  const code = value.trim();
  return code && !/[\r\n]/.test(code) ? code : null;
}

function drain(child: ChildProcessWithoutNullStreams): void {
  child.stdout.resume();
  child.stderr.resume();
}

async function runStatusCommand(
  dependencies: ClaudeAuthCliDependencies,
  signal?: AbortSignal,
): Promise<string> {
  const child = spawnAuth(['auth', 'status', '--json'], dependencies);
  let output = '';
  child.stdout.on('data', chunk => { output = appendBounded(output, chunk); });
  child.stderr.resume();
  await waitForExit(child, dependencies, { signal, failureCode: 'claude_auth_status_failed' });
  return output;
}

function parseStatus(output: string): ClaudeAuthStatus {
  try {
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    if (typeof parsed.loggedIn !== 'boolean') throw new Error('missing loggedIn');
    return {
      loggedIn: parsed.loggedIn,
      authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
      apiProvider: typeof parsed.apiProvider === 'string' ? parsed.apiProvider : null,
    };
  } catch {
    throw cliError('claude_auth_status_invalid', 'Claude authentication status was invalid.');
  }
}

export async function readClaudeAuthStatus(
  dependencies: ClaudeAuthCliDependencies = {},
  signal?: AbortSignal,
): Promise<ClaudeAuthStatus> {
  return parseStatus(await runStatusCommand(dependencies, signal));
}

interface AuthorizationContext {
  child: ChildProcessWithoutNullStreams;
  options: ClaudeAuthLoginOptions;
  buffer: string;
  started: boolean;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

function failAuthorization(
  context: AuthorizationContext,
  error: Error,
  kill: boolean,
): void {
  if (context.settled) return;
  context.settled = true;
  if (kill) {
    try { context.child.kill('SIGTERM'); } catch {}
  }
  context.reject(error);
}

function writeAuthorization(context: AuthorizationContext, code: string): void {
  context.settled = true;
  try {
    context.child.stdin.write(`${code}\n`);
    context.options.onCodeSubmitted?.();
    context.resolve();
  } catch {
    try { context.child.kill('SIGTERM'); } catch {}
    context.reject(commandError('claude_auth_login_failed'));
  }
}

async function submitAuthorization(context: AuthorizationContext, url: string): Promise<void> {
  try {
    const code = normalizeCode(await context.options.onAuthorization(url));
    if (!code) throw commandError('claude_auth_login_failed');
    if (context.settled || context.options.signal?.aborted) return;
    writeAuthorization(context, code);
  } catch {
    failAuthorization(context, commandError('claude_auth_login_failed'), true);
  }
}

function inspectAuthorization(context: AuthorizationContext, chunk: unknown): void {
  context.buffer = appendBounded(context.buffer, chunk);
  const text = stripTerminal(context.buffer);
  const url = text.match(AUTH_URL_PATTERN)?.[0];
  if (context.started || !url || !text.includes(AUTH_PROMPT)) return;
  context.started = true;
  void submitAuthorization(context, url);
}

function authorizationPromise(
  child: ChildProcessWithoutNullStreams,
  options: ClaudeAuthLoginOptions,
  terminationError: () => Error | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const context: AuthorizationContext = {
      child, options, buffer: '', started: false, settled: false, resolve, reject,
    };
    const inspect = (chunk: unknown) => inspectAuthorization(context, chunk);
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('close', () => failAuthorization(
      context,
      terminationError() ?? cliError(
        'claude_auth_login_protocol',
        'Claude authentication did not complete browser authorization.',
      ),
      false,
    ));
  });
}

export async function loginClaudeAuth(
  options: ClaudeAuthLoginOptions,
  dependencies: ClaudeAuthCliDependencies = {},
): Promise<ClaudeAuthStatus> {
  const child = spawnAuth(['auth', 'login', '--claudeai'], dependencies);
  let stoppedWith: Error | null = null;
  const authorization = authorizationPromise(child, options, () => stoppedWith);
  await Promise.all([
    authorization,
    waitForExit(child, dependencies, {
      signal: options.signal,
      failureCode: 'claude_auth_login_failed',
      onStop: error => { stoppedWith = error; },
    }),
  ]);
  const status = await readClaudeAuthStatus(dependencies, options.signal);
  if (!status.loggedIn) {
    throw cliError('claude_auth_not_logged_in', 'Claude Code did not persist the login.');
  }
  return status;
}

export async function logoutClaudeAuth(
  dependencies: ClaudeAuthCliDependencies = {},
  signal?: AbortSignal,
): Promise<void> {
  const child = spawnAuth(['auth', 'logout'], dependencies);
  drain(child);
  await waitForExit(child, dependencies, { signal, failureCode: 'claude_auth_logout_failed' });
  const status = await readClaudeAuthStatus(dependencies, signal);
  if (status.loggedIn) {
    throw cliError('claude_auth_still_logged_in', 'Claude Code remained logged in after logout.');
  }
}
