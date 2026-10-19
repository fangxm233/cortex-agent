import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

/**
 * The `agent-browser` engine behind `cortex-browser`: locating its native binary and the argument
 * and environment rules every invocation must follow. Shared by the daemon-side broker and the
 * agent-side CLI, so the two can never disagree about which daemon or tab they are talking to.
 */

/** Operator override for the binary, e.g. a locally built one. */
export const AGENT_BROWSER_BIN_ENV = 'CORTEX_AGENT_BROWSER_BIN';

export interface AgentBrowserRun {
  code: number;
  stdout: string;
  stderr: string;
}

export class AgentBrowserMissingError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'AgentBrowserMissingError';
    this.hint = hint;
  }
}

function isMusl(): boolean {
  const header = (process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return !header?.glibcVersionRuntime;
}

/** Native binary file name for this host, matching the package's own launcher. */
export function agentBrowserBinaryName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: () => boolean = isMusl,
): string | null {
  const osKey = platform === 'darwin' ? 'darwin'
    : platform === 'linux' ? (musl() ? 'linux-musl' : 'linux')
      : platform === 'win32' ? 'win32' : null;
  // Windows on ARM runs the x64 build under emulation, as the package launcher does.
  const archKey = arch === 'x64' ? 'x64' : arch === 'arm64' ? (platform === 'win32' ? 'x64' : 'arm64') : null;
  if (!osKey || !archKey) return null;
  return `agent-browser-${osKey}-${archKey}${platform === 'win32' ? '.exe' : ''}`;
}

/** pnpm skips the package's postinstall, which is what normally sets the execute bit. */
function ensureExecutable(file: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    fs.chmodSync(file, 0o755);
  }
}

/**
 * Absolute path of the agent-browser native binary. `CORTEX_AGENT_BROWSER_BIN` wins; otherwise the
 * pinned dependency's own binary. Never PATH: a globally installed agent-browser is a different
 * version, and its skill text would not match the commands.
 */
export function resolveAgentBrowserBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AGENT_BROWSER_BIN_ENV];
  if (override) {
    if (!fs.existsSync(override)) {
      throw new AgentBrowserMissingError(
        `${AGENT_BROWSER_BIN_ENV} points at ${override}, which does not exist`,
        `fix or unset ${AGENT_BROWSER_BIN_ENV}`,
      );
    }
    return override;
  }
  let pkgDir: string;
  try {
    pkgDir = path.dirname(createRequire(import.meta.url).resolve('agent-browser/package.json'));
  } catch {
    throw new AgentBrowserMissingError(
      'the agent-browser package is not installed with this Cortex server',
      `reinstall @cortex-agent/server, or set ${AGENT_BROWSER_BIN_ENV} to an agent-browser binary`,
    );
  }
  const name = agentBrowserBinaryName();
  const file = name ? path.join(pkgDir, 'bin', name) : null;
  if (!file || !fs.existsSync(file)) {
    throw new AgentBrowserMissingError(
      `agent-browser has no binary for ${process.platform}-${process.arch}`,
      `build one and set ${AGENT_BROWSER_BIN_ENV} to its path`,
    );
  }
  ensureExecutable(file);
  return file;
}

/** Device names and session ids become part of a socket file name; keep them filesystem-safe. */
function slug(value: string, max: number): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, max) || 'x';
}

/** The agent-browser session (daemon + pinned tab) for one Cortex session on one device. */
export function agentBrowserSessionName(sessionId: string, device: string): string {
  return `cortex-${slug(sessionId, 36)}-${slug(device, 24)}`;
}

/**
 * The arguments every call carries. `--cdp` is not sticky: one call without it makes the daemon
 * launch a Chrome of its own. `--pin-tab` keeps the session on its own tab when several sessions
 * share one Chrome.
 */
export function agentBrowserArgs(cdpEndpoint: string, abSession: string, args: string[]): string[] {
  return ['--cdp', cdpEndpoint, '--session', abSession, '--pin-tab', ...args];
}

/** The bound tab no longer exists (the Chrome behind it was replaced or the tab was closed). */
export function isTabGone(stderr: string): boolean {
  return /(^|\s)tab_gone[:\s]/.test(stderr) || stderr.includes('"code":"tab_gone"');
}

/** Variables an agent-browser daemon may inherit. Everything else — tokens, API keys, chat
 *  credentials — stays out of a long-lived third-party process. */
const ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE',
]);

/** Variables the broker decides and a caller's environment must not override. */
const ENV_PINNED = new Set([
  'AGENT_BROWSER_SOCKET_DIR', 'AGENT_BROWSER_SESSION', 'AGENT_BROWSER_CDP', 'AGENT_BROWSER_NAMESPACE',
  'AGENT_BROWSER_PROVIDER', 'AGENT_BROWSER_AUTO_CONNECT', 'AGENT_BROWSER_PIN_TAB', 'AGENT_BROWSER_ENGINE',
]);

function defaultSocketDir(env: NodeJS.ProcessEnv): string {
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'agent-browser');
  return path.join(env.HOME || os.homedir(), '.agent-browser');
}

/**
 * The environment agent-browser runs under, computed once in the daemon and handed to every CLI
 * call. Pinning the socket directory is what makes the CLI and the daemon reach the same
 * agent-browser daemon: tab bindings live beside its socket, so two directories would mean two
 * tabs for one session.
 */
export function agentBrowserBaseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_ALLOW.has(key) || key.startsWith('LC_') || (key.startsWith('AGENT_BROWSER_') && !ENV_PINNED.has(key))) {
      out[key] = value;
    }
  }
  out.AGENT_BROWSER_SOCKET_DIR = env.AGENT_BROWSER_SOCKET_DIR || defaultSocketDir(env);
  return out;
}

/** `base` plus the caller's own AGENT_BROWSER_* tuning (output limits, timeouts), minus anything
 *  that would redirect it to another daemon, browser or tab. */
export function agentBrowserCallEnv(base: Record<string, string>, callerEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out = { ...base };
  for (const [key, value] of Object.entries(callerEnv)) {
    if (value !== undefined && key.startsWith('AGENT_BROWSER_') && !ENV_PINNED.has(key)) out[key] = value;
  }
  return out;
}

/** Run agent-browser to completion, capturing output. For the daemon's own calls; the CLI streams. */
export function runAgentBrowserProcess(
  bin: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs?: number; cwd?: string },
): Promise<AgentBrowserRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(bin, args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const finish = (run: AgentBrowserRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: 124, stdout, stderr: `${stderr}agent-browser timed out after ${opts.timeoutMs}ms\n` });
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (e) => finish({ code: 127, stdout, stderr: `${stderr}cannot run ${bin}: ${e.message}\n` }));
    child.on('close', (code, signal) => finish({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}
