import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { formatError, formatHelp, type HelpSpec } from '@core/cli-utils.js';
import { AUTH_HEADER } from '@core/auth.js';
import { isMainModule } from '@core/utils.js';
import {
  agentBrowserArgs, agentBrowserBaseEnv, agentBrowserCallEnv, isTabGone, resolveAgentBrowserBin,
  AgentBrowserMissingError,
} from '@platform/browser/agent-browser.js';

/**
 * `cortex-browser`: agent-browser, attached to the Chrome Cortex manages for this session.
 *
 * Each call leases the session's browser from the daemon (starting Chrome if needed), then runs
 * agent-browser here so its output streams straight back. Every failure is an error with a reason;
 * nothing quietly falls back to a different browser.
 */

const HELP: HelpSpec = {
  name: 'cortex-browser',
  description: [
    "Drive a real browser from any Cortex session: agent-browser, attached to the session's own tab",
    "in the Chrome Cortex manages on the server or on one of your devices.",
    '',
    'Every argument except --device is passed to agent-browser. Full command guide:',
    '  cortex-browser skills get core',
  ].join('\n'),
  usage: 'cortex-browser [--device <name>] <agent-browser command> [args...]',
  options: [
    { flag: '--device <name>', description: "Whose Chrome: 'server' or a connected device. Sticks for the session", default: "the session's last device, else server" },
    { flag: '--help, -h', description: 'Show this help (agent-browser <command> --help for one command)' },
  ],
  examples: [
    { description: 'Open a page and list what can be clicked', command: 'cortex-browser open http://127.0.0.1:5173 && cortex-browser snapshot -i' },
    { description: 'Click a ref from the snapshot, then capture the result', command: 'cortex-browser click @e2 && cortex-browser screenshot ./after-click.png' },
    { description: "Use the Chrome on the user's machine (its localhost, its logins)", command: 'cortex-browser --device my-pc open https://example.com' },
    { description: 'Read the version-matched command reference', command: 'cortex-browser skills get core --full' },
  ],
};

/** Flags that would point agent-browser at a different browser, daemon or tab than the lease. */
const RESERVED_FLAGS = new Set([
  '--cdp', '--session', '--no-pin-tab', '--auto-connect', '--provider', '-p', '--namespace', '--engine',
  '--executable-path',
]);

/** Commands that need no browser and so no lease. */
const LOCAL_COMMANDS = new Set(['skills', 'help']);

/** Commands that would change the shared setup underneath every session. */
const BLOCKED_COMMANDS: Record<string, string> = {
  connect: 'cortex-browser already connects each call to the session browser',
  install: 'Chrome is managed by Cortex; agent-browser does not install its own',
  upgrade: 'agent-browser is pinned to the version Cortex ships with',
  dashboard: "watch the browser in the Cortex app's Agent browser tab instead",
  mcp: 'call cortex-browser commands directly',
};

/** Global agent-browser flags that take a value, so the value is not mistaken for the command. */
const VALUE_FLAGS = new Set([
  '--session', '--namespace', '--executable-path', '--extension', '--init-script', '--enable', '--args',
  '--user-agent', '--proxy', '--proxy-bypass', '--ca-cert', '--hide-scrollbars', '--provider', '-p',
  '--screenshot-dir', '--screenshot-quality', '--screenshot-format', '--input-mode', '--cdp',
  '--color-scheme', '--download-path', '--max-output', '--allowed-domains', '--action-policy',
  '--confirm-actions', '--idle-timeout', '--engine', '--model', '--config', '--profile',
  '--restore-save', '--restore-check-url', '--restore-check-text', '--restore-check-fn', '--session-name',
  '--state', '--headers', '--threshold', '--baseline', '-d', '--depth', '-s', '--selector',
]);

/** Flags whose value is a directory or file wherever they appear. */
const PATH_FLAGS = new Set(['--screenshot-dir', '--download-path', '--baseline']);

/**
 * Commands that write or read local files, and how many leading positionals are not files
 * (`download <selector> <path>`). The daemon resolves a relative path against ITS working
 * directory, not the caller's, so these are made absolute before they leave this process.
 */
const FILE_COMMANDS: Record<string, number> = {
  screenshot: 0, pdf: 0, download: 1, upload: 1, record: 0, trace: 0, profiler: 0, network: 0, har: 0,
  state: 0, diff: 0,
};

const FILE_EXTENSIONS = /\.(png|jpe?g|webp|gif|pdf|webm|mp4|json|har|zip|txt|html?|csv|xml|md|log|cpuprofile)$/i;

export interface ParsedBrowserArgs {
  help: boolean;
  device: string | null;
  args: string[];
  command: string | null;
}

export class BrowserUsageError extends Error {}

/** The first token that is neither a flag nor a flag's value, with its index. */
function findCommand(args: string[]): { command: string | null; index: number } {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.startsWith('-')) {
      if (VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    return { command: token, index: i };
  }
  return { command: null, index: -1 };
}

export function parseBrowserArgs(argv: string[]): ParsedBrowserArgs {
  let device: string | null = null;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--device' || token.startsWith('--device=')) {
      const value = token === '--device' ? argv[i + 1] : token.slice('--device='.length);
      if (!value || value.startsWith('-')) {
        throw new BrowserUsageError(formatError('--device requires a device name', {
          hint: "use 'server' for this machine, or a connected device name (cortex-browser --device my-pc open …)",
        }));
      }
      device = value;
      if (token === '--device') i += 1;
      continue;
    }
    const flag = token.split('=')[0];
    if (RESERVED_FLAGS.has(flag)) {
      throw new BrowserUsageError(formatError(`${flag} is set by cortex-browser and cannot be passed`, {
        hint: 'cortex-browser attaches every call to this session\'s own tab; use --device to pick whose Chrome',
      }));
    }
    if (token === '--pin-tab') continue; // always on
    args.push(token);
  }
  const { command } = findCommand(args);
  // No command at all (`cortex-browser`, `cortex-browser --device x`) shows this help rather than
  // leasing a browser just to print agent-browser's.
  const help = command === null && !args.some((a) => a === '--version' || a === '-V');
  if (command && Object.hasOwn(BLOCKED_COMMANDS, command)) {
    throw new BrowserUsageError(formatError(`'${command}' is not available through cortex-browser`, {
      hint: BLOCKED_COMMANDS[command],
    }));
  }
  if (command === 'close' && args.includes('--all')) {
    throw new BrowserUsageError(formatError("'close --all' would disconnect every other session's browser", {
      hint: "use 'cortex-browser close' to close only this session's connection",
    }));
  }
  return { help, device, args, command };
}

/** Does this command run without a browser (help, version, bundled skills)? */
export function isLocalCommand(parsed: ParsedBrowserArgs): boolean {
  if (parsed.command && LOCAL_COMMANDS.has(parsed.command)) return true;
  if (parsed.args.some((a) => a === '--help' || a === '-h')) return true;
  return parsed.command === null && parsed.args.some((a) => a === '--version' || a === '-V');
}

function looksLikePath(token: string): boolean {
  if (!token || token.startsWith('-') || token.startsWith('@') || token.includes('://')) return false;
  if (/[*?{}[\]]/.test(token)) return false; // a URL pattern (`network route "*.png"`), not a file
  if (path.isAbsolute(token)) return false;
  return token.startsWith('./') || token.startsWith('../') || FILE_EXTENSIONS.test(token);
}

/** Make the file arguments of file-writing commands absolute against the caller's directory. */
export function absolutizePaths(args: string[], cwd: string): string[] {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i += 1) {
    if (PATH_FLAGS.has(out[i]) && !path.isAbsolute(out[i + 1]) && !out[i + 1].startsWith('-')) {
      out[i + 1] = path.resolve(cwd, out[i + 1]);
    }
  }
  const { command, index } = findCommand(out);
  if (!command || !Object.hasOwn(FILE_COMMANDS, command)) return out;
  let skip = FILE_COMMANDS[command];
  for (let i = index + 1; i < out.length; i += 1) {
    const token = out[i];
    if (token.startsWith('-')) {
      if (VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    if (skip > 0) { skip -= 1; continue; }
    if (looksLikePath(token)) out[i] = path.resolve(cwd, token);
  }
  return out;
}

export interface LeaseData {
  device: string;
  cdpEndpoint: string;
  abSession: string;
  bin: string;
  env: Record<string, string>;
}

export interface BrowserCliOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  post?: (url: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; body: any }>;
  /** Run agent-browser with stdout passed through; resolves its exit code and captured stderr. */
  exec?: (bin: string, args: string[], env: Record<string, string>, cwd: string) => Promise<{ code: number; stderr: string }>;
  writeErr?: (text: string) => void;
  /** Delay before telling the caller the browser is still starting. */
  slowNoticeMs?: number;
}

async function httpPost(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    // A device's first Chrome launch can take the device's own 90s budget plus the round trip.
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* non-JSON bodies surface as text */ }
  return { status: response.status, body: parsed };
}

/** stdout passes straight through; stderr is held so a recoverable tab_gone can be retried
 *  without showing the agent an error that was already handled. */
function spawnExec(bin: string, args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(bin, args, { env, cwd, stdio: ['inherit', 'inherit', 'pipe'] });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (e) => resolve({ code: 127, stderr: `${stderr}cortex-browser: cannot run ${bin}: ${e.message}\n` }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stderr }));
  });
}

class BrowserCliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

async function lease(
  options: Required<Pick<BrowserCliOptions, 'post' | 'writeErr'>> & { slowNoticeMs: number },
  env: NodeJS.ProcessEnv, sessionId: string, device: string | null,
): Promise<LeaseData> {
  const port = env.WEBHOOK_PORT || '3001';
  const url = `http://127.0.0.1:${port}/webhook/browser`;
  const notice = setTimeout(() => {
    options.writeErr(`cortex-browser: starting the browser${device ? ` on ${device}` : ''}…\n`);
  }, options.slowNoticeMs);
  let response: { status: number; body: any };
  try {
    response = await options.post(url, { action: 'lease', sessionId, device }, { [AUTH_HEADER]: env.CORTEX_WEBHOOK_TOKEN || '' });
  } catch (error) {
    throw new BrowserCliError(formatError(`cannot reach the Cortex daemon at 127.0.0.1:${port}: ${(error as Error).message}`, {
      hint: 'cortex-browser works inside Cortex sessions while the Cortex server is running',
    }));
  } finally {
    clearTimeout(notice);
  }
  if (response.status === 401) {
    throw new BrowserCliError(formatError('the Cortex daemon rejected this call (bad or missing CORTEX_WEBHOOK_TOKEN)', {
      hint: 'run cortex-browser from a Cortex session, which sets the token',
    }));
  }
  if (response.status === 404) {
    throw new BrowserCliError(formatError('this Cortex server has no browser endpoint yet', {
      hint: 'the server needs a restart onto the version that ships cortex-browser',
    }));
  }
  const body = response.body;
  if (response.status !== 200 || !body?.success) {
    const detail = typeof body === 'object' && body ? body.error : String(body ?? '');
    throw new BrowserCliError(formatError(`browser unavailable: ${detail || `HTTP ${response.status}`}`, { hint: body?.hint }));
  }
  return body.data as LeaseData;
}

export async function runBrowserCli(argv: string[], options: BrowserCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const writeErr = options.writeErr ?? ((text: string) => { process.stderr.write(text); });
  const exec = options.exec ?? spawnExec;
  const post = options.post ?? httpPost;

  let parsed: ParsedBrowserArgs;
  try {
    parsed = parseBrowserArgs(argv);
  } catch (error) {
    if (error instanceof BrowserUsageError) { writeErr(`${error.message}\n`); return 2; }
    throw error;
  }
  if (parsed.help) {
    process.stdout.write(`${formatHelp(HELP)}\n`);
    return 0;
  }

  try {
    if (isLocalCommand(parsed)) {
      const bin = resolveAgentBrowserBin(env);
      const run = await exec(bin, parsed.args, agentBrowserBaseEnv(env), cwd);
      if (run.stderr) writeErr(run.stderr);
      return run.code;
    }

    const sessionId = env.CORTEX_SESSION_ID || env.CORTEX_EXECUTION_ID || '';
    if (!sessionId) {
      writeErr(`${formatError('no Cortex session (CORTEX_SESSION_ID is unset)', {
        hint: 'cortex-browser leases a browser per Cortex session; run it from a session\'s shell',
      })}\n`);
      return 2;
    }
    const data = await lease({ post, writeErr, slowNoticeMs: options.slowNoticeMs ?? 2_000 }, env, sessionId, parsed.device);
    const callEnv = agentBrowserCallEnv(data.env, env);
    const args = absolutizePaths(parsed.args, cwd);
    let run = await exec(data.bin, agentBrowserArgs(data.cdpEndpoint, data.abSession, args), callEnv, cwd);
    if (run.code !== 0 && isTabGone(run.stderr)) {
      // The tab this session was bound to is gone (Chrome was restarted, or someone closed it).
      // The command never ran, so binding a fresh tab and running it once more is safe.
      const rebound = await exec(data.bin, agentBrowserArgs(data.cdpEndpoint, data.abSession, ['tab', 'new']), callEnv, cwd);
      if (rebound.code === 0) {
        writeErr('cortex-browser: the previous tab was gone, so this session now has a new blank tab\n');
        run = await exec(data.bin, agentBrowserArgs(data.cdpEndpoint, data.abSession, args), callEnv, cwd);
      }
    }
    if (run.stderr) writeErr(run.stderr);
    await post(`http://127.0.0.1:${env.WEBHOOK_PORT || '3001'}/webhook/browser`, { action: 'report', sessionId },
      { [AUTH_HEADER]: env.CORTEX_WEBHOOK_TOKEN || '' }).catch(() => undefined);
    return run.code;
  } catch (error) {
    if (error instanceof BrowserCliError) { writeErr(`${error.message}\n`); return error.exitCode; }
    if (error instanceof AgentBrowserMissingError) {
      writeErr(`${formatError(error.message, { hint: error.hint })}\n`);
      return 1;
    }
    writeErr(`cortex-browser: ${(error as Error).message}\n`);
    return 1;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runBrowserCli(argv);
}

if (isMainModule(import.meta.url)) {
  void main();
}
