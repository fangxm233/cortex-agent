// input:  process argv, child processes, CLI handler modules
// output: cortex CLI dispatch and process exit status
// pos:    Top-level cortex command dispatcher
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { fork } from 'child_process';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync, mkdirSync, writeFileSync, utimesSync, readFileSync, unlinkSync } from 'fs';
import { INSTALL_ROOT, DATA_DIR, STORE_DIR, PROJECTS_DIR, WORKSPACE_DIR, isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import {
  getResolvedPaths,
  formatConfigOutput,
  runInit,
} from './init.js';
import type { ConfigStatus } from './init.js';
import { cmdFeishu } from './feishu-login.js';
import { cmdDoctor, getDoctorHelp } from './doctor-cli.js';
import { discoverEndpoints, writeMergedGatewayYaml, validateProfilesAgainstGateway, dryRunGatewayYaml } from '@core/gateway-generator.js';
import { generateProfiles, writeProfilesJson } from '@core/profile-generator.js';
import { CORTEX_VERSION } from '@core/version.js';
import { getAuthStatus } from '@domain/auth/auth-status.js';
import { GATEWAY_URL } from '@domain/costs/gateway-manager.js';
import {
  GATEWAY_CONFIG_PATH,
  USER_PI_MODELS_PATH,
  type CustomProviderStores,
} from '@domain/pi-providers/index.js';
import { runAuthCli, type AuthCliDeps } from './auth-cli.js';
import {
  getCliHelp,
  getInitHelp,
  getSetupGatewayHelp,
  getTuiHelp,
} from './cli-help.js';

export { getAuthHelp, getCliHelp, getInitHelp, getSetupGatewayHelp, getTuiHelp } from './cli-help.js';

// ─── Paths ──────────────────────────────────────────────────────

const log = createLogger('cli');

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(MODULE_DIR, 'app.js');
const DAEMON_JS = path.join(MODULE_DIR, 'daemon.js');
const TUI_JS = path.join(MODULE_DIR, '..', 'tui', 'index.js');

// ─── TUI arguments ─────────────────────────────────────────────────

export interface TuiCliOptions {
  resume: boolean;
  project?: string;
  port?: number;
}

/** Parse arguments for the `cortex tui` subcommand. */
export function parseTuiArgs(args: string[]): TuiCliOptions {
  const opts: TuiCliOptions = { resume: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--resume':
        opts.resume = true;
        break;
      case '--project':
        opts.project = args[++i];
        break;
      case '--port':
        opts.port = Number(args[++i]);
        break;
    }
  }
  return opts;
}

/** Check whether a TCP server is listening on 127.0.0.1:port (500ms timeout). */
export function tuiPortListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.end();
      resolve(true);
    });
    sock.setTimeout(500);
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => resolve(false));
  });
}

/** Execute the `cortex tui` subcommand: check daemon liveness, fork Ink client. */
export async function cmdTui(args: string[]): Promise<void> {
  const opts = parseTuiArgs(args);
  const port = opts.port ?? (Number(process.env.CORTEX_TUI_PORT) || 3003);

  if (!await tuiPortListening(port)) {
    process.stderr.write(
      `Cortex daemon is not running on port ${port}.\n` +
      `Start it with: cortex daemon\n`,
    );
    process.exit(1);
  }

  if (!existsSync(TUI_JS)) {
    log.error(`TUI entry not found: ${TUI_JS}`);
    log.error('Run `npm run build` first.');
    process.exit(1);
  }

  const childArgs: string[] = [];
  if (opts.resume) childArgs.push('--resume');
  if (opts.project) { childArgs.push('--project', opts.project); }

  const child = fork(TUI_JS, childArgs, {
    stdio: 'inherit',
    env: { ...process.env, CORTEX_TUI_PORT: String(port) },
  });
  child.on('exit', code => process.exit(code ?? 0));
  await new Promise<never>(() => {}); // keep alive until child exits
}

// ─── Daemon stop ──────────────────────────────────────────────────

async function stopDaemonInternal(): Promise<CliResult> {
  const pidFile = path.join(STORE_DIR, 'daemon.pid');

  // Case 1: No PID file
  if (!existsSync(pidFile)) {
    return { exitCode: 0, stdout: 'Cortex daemon is not running.\n', stderr: '' };
  }

  // Read PID
  let pid: number;
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) {
      try { unlinkSync(pidFile); } catch {}
      return { exitCode: 0, stdout: 'Cortex daemon is not running (removed corrupted PID file).\n', stderr: '' };
    }
  } catch (err: any) {
    return { exitCode: 1, stdout: '', stderr: `Failed to read PID file: ${err.message}\n` };
  }

  // Case 2: PID file exists but process is dead (stale)
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (!alive) {
    try { unlinkSync(pidFile); } catch {}
    return { exitCode: 0, stdout: `Cortex daemon is not running (removed stale PID file for PID ${pid}).\n`, stderr: '' };
  }

  // Case 3: Process is alive — send SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: any) {
    return { exitCode: 1, stdout: '', stderr: `Failed to send signal to daemon (PID ${pid}): ${err.message}\n` };
  }

  // Poll until the process exits (up to 10 seconds, 200ms intervals)
  const maxWaitMs = 10_000;
  const pollIntervalMs = 200;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    try { process.kill(pid, 0); } catch { break; }
  }

  // Recheck liveness
  try {
    process.kill(pid, 0);
    // Still alive after timeout — force kill
    try { process.kill(pid, 'SIGKILL'); } catch {}
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Daemon (PID ${pid}) did not stop within ${maxWaitMs / 1000}s. Forcibly killed (SIGKILL).\n`,
    };
  } catch {
    // Process is dead — success
  }

  // Clean up PID file in case daemon's exit handler didn't run
  try {
    if (existsSync(pidFile)) {
      const raw = readFileSync(pidFile, 'utf8').trim();
      if (Number(raw) === pid) unlinkSync(pidFile);
    }
  } catch {}

  return { exitCode: 0, stdout: `Cortex daemon stopped (PID ${pid}).\n`, stderr: '' };
}

// ─── Daemon status ────────────────────────────────────────────────

/** Format a duration in milliseconds as a human-readable string. */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** Get the uptime of a process from /proc/<pid>/stat. Returns 'unknown' on non-Linux or failure. */
function getProcessUptime(pid: number): string {
  try {
    const statPath = `/proc/${pid}/stat`;
    if (!existsSync(statPath)) return 'unknown';

    const stat = readFileSync(statPath, 'utf8');
    // Format: pid (comm) state ppid ... starttime ...
    // starttime is field 22 (1-indexed), which is index 19 in the fields after comm
    const commEnd = stat.lastIndexOf(')');
    const afterComm = stat.substring(commEnd + 2).split(' ');
    const starttimeTicks = parseInt(afterComm[19], 10);
    if (!Number.isFinite(starttimeTicks)) return 'unknown';

    const uptimeRaw = readFileSync('/proc/uptime', 'utf8');
    const systemUptimeSec = parseFloat(uptimeRaw.split(' ')[0]);
    const clkTck = 100; // Linux CONFIG_HZ default
    const bootTimeMs = Date.now() - systemUptimeSec * 1000;
    const processStartMs = bootTimeMs + (starttimeTicks / clkTck) * 1000;
    const elapsedMs = Date.now() - processStartMs;

    if (elapsedMs < 0) return 'unknown';
    return formatDuration(elapsedMs);
  } catch {
    return 'unknown';
  }
}

function getDaemonStatusInternal(): CliResult {
  const pidFile = path.join(STORE_DIR, 'daemon.pid');

  // Case 1: No PID file
  if (!existsSync(pidFile)) {
    return { exitCode: 0, stdout: 'Cortex daemon is not running.\n', stderr: '' };
  }

  // Read PID
  let pid: number;
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) {
      try { unlinkSync(pidFile); } catch {}
      return { exitCode: 0, stdout: 'Cortex daemon is not running (removed corrupted PID file).\n', stderr: '' };
    }
  } catch (err: any) {
    return { exitCode: 1, stdout: '', stderr: `Failed to read PID file: ${err.message}\n` };
  }

  // Case 2: PID file exists but process is dead (stale)
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (!alive) {
    try { unlinkSync(pidFile); } catch {}
    return { exitCode: 0, stdout: `Cortex daemon is not running (removed stale PID file for PID ${pid}).\n`, stderr: '' };
  }

  // Case 3: Process is alive — report status
  const uptime = getProcessUptime(pid);

  const lines = [
    'Cortex daemon is running.',
    `  PID:     ${pid}`,
    `  Uptime:  ${uptime}`,
  ];

  // Check child (app.js) status via daemon-child.pid
  const childPidFile = path.join(STORE_DIR, 'daemon-child.pid');
  if (existsSync(childPidFile)) {
    try {
      const raw = readFileSync(childPidFile, 'utf8').trim();
      const childPid = Number(raw);
      if (Number.isFinite(childPid) && childPid > 0) {
        let childAlive = false;
        try { process.kill(childPid, 0); childAlive = true; } catch {}
        if (childAlive) {
          const childUptime = getProcessUptime(childPid);
          lines.push(`  Child:   app.js (PID ${childPid}, uptime ${childUptime})`);
        } else {
          lines.push(`  Child:   none (stale PID ${childPid} — daemon will restart)`);
        }
      }
    } catch {}
  }
  if (!lines.some(l => l.startsWith('  Child:'))) {
    lines.push('  Child:   starting...');
  }

  return { exitCode: 0, stdout: lines.join('\n') + '\n', stderr: '' };
}

// ─── Daemon restart ────────────────────────────────────────────────

function daemonRestartInternal(): CliResult {
  const pidFile = path.join(STORE_DIR, 'daemon.pid');

  if (!existsSync(pidFile)) {
    return { exitCode: 1, stdout: '', stderr: 'Cortex daemon is not running. Nothing to restart.\n' };
  }

  let pid: number;
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { exitCode: 1, stdout: '', stderr: 'Daemon PID file is corrupted. Is the daemon running?\n' };
    }
  } catch (err: any) {
    return { exitCode: 1, stdout: '', stderr: `Failed to read PID file: ${err.message}\n` };
  }

  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (!alive) {
    try { unlinkSync(pidFile); } catch {}
    return { exitCode: 1, stdout: '', stderr: 'Cortex daemon is not running. Nothing to restart.\n' };
  }

  // Touch .restart trigger file for the daemon to pick up
  const trigger = path.join(STORE_DIR, '.restart');
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    if (existsSync(trigger)) {
      const now = new Date();
      utimesSync(trigger, now, now);
    } else {
      writeFileSync(trigger, '');
    }
    return { exitCode: 0, stdout: `Restart signal sent to daemon (PID ${pid}).\n`, stderr: '' };
  } catch (err: any) {
    return { exitCode: 1, stdout: '', stderr: `Failed to signal daemon restart: ${err.message || String(err)}\n` };
  }
}

// ─── Daemon hard restart (SIGTERM/SIGKILL directly to app.js) ─────

function daemonRestartHardInternal(force: boolean): CliResult {
  const pidFile = path.join(STORE_DIR, 'daemon.pid');

  // Verify daemon is running first
  if (!existsSync(pidFile)) {
    return { exitCode: 1, stdout: '', stderr: 'Cortex daemon is not running. Nothing to restart.\n' };
  }

  let daemonPid: number;
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    daemonPid = Number(raw);
    if (!Number.isFinite(daemonPid) || daemonPid <= 0) {
      return { exitCode: 1, stdout: '', stderr: 'Daemon PID file is corrupted.\n' };
    }
  } catch (err: any) {
    return { exitCode: 1, stdout: '', stderr: `Failed to read daemon PID file: ${err.message}\n` };
  }

  let daemonAlive = false;
  try { process.kill(daemonPid, 0); daemonAlive = true; } catch {}
  if (!daemonAlive) {
    try { unlinkSync(pidFile); } catch {}
    return { exitCode: 1, stdout: '', stderr: 'Cortex daemon is not running.\n' };
  }

  // Read child PID
  const childPidFile = path.join(STORE_DIR, 'daemon-child.pid');
  if (!existsSync(childPidFile)) {
    return { exitCode: 1, stdout: '', stderr: 'No child PID file found. Is app.js running?\n' };
  }

  let childPid: number;
  try {
    const raw = readFileSync(childPidFile, 'utf8').trim();
    childPid = Number(raw);
    if (!Number.isFinite(childPid) || childPid <= 0) {
      return { exitCode: 1, stdout: '', stderr: 'Child PID file is corrupted.\n' };
    }
  } catch (err: any) {
    return { exitCode: 1, stdout: '', stderr: `Failed to read child PID file: ${err.message}\n` };
  }

  let childAlive = false;
  try { process.kill(childPid, 0); childAlive = true; } catch {}
  if (!childAlive) {
    return { exitCode: 1, stdout: '', stderr: `Child process (PID ${childPid}) is not running.\n` };
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(childPid, signal);
  } catch (err: any) {
    return { exitCode: 1, stdout: '', stderr: `Failed to send ${signal} to app.js (PID ${childPid}): ${err.message}\n` };
  }

  return { exitCode: 0, stdout: `Sent ${signal} to app.js (PID ${childPid}). Daemon will restart it automatically.\n`, stderr: '' };
}

// ─── Config output ──────────────────────────────────────────────

export function getConfigOutput(): string {
  const paths = {
    INSTALL_ROOT,
    ...getResolvedPaths(),
  };

  const dotEnvPath = path.join(paths.CONFIG_DIR, '.env');
  const mcpConfigPath = path.join(paths.CONFIG_DIR, 'mcp-config.json');
  const modeJsonPath = path.join(paths.STORE_DIR, 'mode.json');

  let storeFileCount = 0;
  try { storeFileCount = readdirSync(paths.STORE_DIR).length; } catch {}

  const status: ConfigStatus = {
    dataDirExists: existsSync(paths.DATA_DIR) && storeFileCount > 0,
    dotEnvExists: existsSync(dotEnvPath),
    mcpConfigExists: existsSync(mcpConfigPath),
    modeJsonExists: existsSync(modeJsonPath),
  };

  return formatConfigOutput(paths, status);
}

// ─── CLI Result type ────────────────────────────────────────────

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCliDeps extends AuthCliDeps {}

// ─── runCli (synchronous/async commands) ────────────────────────

type CliHandler = (args: string[], deps: RunCliDeps) => Promise<CliResult> | CliResult;
type GatewayMergeResult = ReturnType<typeof writeMergedGatewayYaml>['result'];
type GatewayIssues = ReturnType<typeof validateProfilesAgainstGateway>;

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined;
}

async function runInitCli(args: string[]): Promise<CliResult> {
  if (args.includes('--help') || args.includes('-h')) {
    return { exitCode: 0, stdout: getInitHelp(), stderr: '' };
  }
  const homeDir = optionValue(args, '--home');
  const gatewayConfigDir = optionValue(args, '--gateway-config-dir');
  try {
    await runInit({ homeDir, gatewayConfigDir, force: args.includes('--force') });
    return { exitCode: 0, stdout: '', stderr: '' };
  } catch (error: any) {
    return { exitCode: 1, stdout: '', stderr: error.message || String(error) };
  }
}

function runDoctorCli(args: string[]): Promise<CliResult> | CliResult {
  if (args.includes('--help') || args.includes('-h')) {
    return { exitCode: 0, stdout: getDoctorHelp(), stderr: '' };
  }
  return cmdDoctor(args);
}

function touchRestartTrigger(trigger: string): void {
  mkdirSync(STORE_DIR, { recursive: true });
  if (!existsSync(trigger)) {
    writeFileSync(trigger, '');
    return;
  }
  const now = new Date();
  utimesSync(trigger, now, now);
}

function runRestartCli(): CliResult {
  const trigger = path.join(STORE_DIR, '.restart');
  try {
    touchRestartTrigger(trigger);
    const stdout = `Restart trigger touched: ${trigger}\nIf a daemon is running it will drain and respawn app.js.\n`;
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error: any) {
    return { exitCode: 1, stdout: '', stderr: `Could not write ${trigger}: ${error.message || String(error)}` };
  }
}

function appendDroppedWarnings(lines: string[], result: GatewayMergeResult): void {
  if (result.droppedFromDiscovery.length === 0) return;
  const list = result.droppedFromDiscovery.map(item => `${item.mode}/${item.endpoint}`).join(', ');
  lines.push(`WARNING: preserved ${result.droppedFromDiscovery.length} existing gateway mode(s) not reported by discovery: ${list}`);
  lines.push('  (if these should auto-detect, check `pi /login` / `pi --list-models`)');
}

function appendProfileIssues(lines: string[], issues: GatewayIssues): void {
  if (issues.length === 0) return;
  lines.push(`WARNING: ${issues.length} profile(s) reference an unconfigured gateway mode (would fail with "Unknown mode"):`);
  for (const issue of issues) lines.push(`  - ${issue.profile}: ${issue.reason}`);
}

function gatewayOutput(
  endpoints: ReturnType<typeof discoverEndpoints>,
  outputDir: string | undefined,
  gatewayPath: string,
  profilesPath: string,
  mergeResult: GatewayMergeResult,
): string {
  const profiles = generateProfiles(endpoints);
  const profileNames = Object.keys(profiles.profiles).join(', ');
  const lines = [
    outputDir ? `[TEST MODE] Output directory: ${outputDir}` : '',
    `Gateway config: ${gatewayPath}`,
    `Profiles: ${profilesPath}`,
    `Discovered ${endpoints.length} endpoint modes`,
    `Generated profiles: ${profileNames} (default: ${profiles.defaultProfile})`,
  ];
  appendDroppedWarnings(lines, mergeResult);
  appendProfileIssues(lines, validateProfilesAgainstGateway(mergeResult.endpoints, outputDir));
  return lines.filter(Boolean).join('\n');
}

function writeGatewayConfiguration(outputDir: string | undefined): CliResult {
  const endpoints = discoverEndpoints();
  if (endpoints.length === 0) {
    return { exitCode: 0, stdout: 'No backends discovered. Log into Claude Code and/or PI first.\n', stderr: '' };
  }
  const { path: gatewayPath, result } = writeMergedGatewayYaml(endpoints, outputDir);
  const profilesPath = writeProfilesJson(endpoints, outputDir);
  return {
    exitCode: 0,
    stdout: gatewayOutput(endpoints, outputDir, gatewayPath, profilesPath, result),
    stderr: '',
  };
}

function runSetupGatewayCli(args: string[]): CliResult {
  if (args.includes('--help') || args.includes('-h')) {
    return { exitCode: 0, stdout: getSetupGatewayHelp(), stderr: '' };
  }
  try {
    if (args.includes('--dry-run')) {
      return { exitCode: 0, stdout: dryRunGatewayYaml(), stderr: '' };
    }
    return writeGatewayConfiguration(optionValue(args, '--output-dir'));
  } catch (error: any) {
    return { exitCode: 1, stdout: '', stderr: error.message || String(error) };
  }
}

async function runTaskCli(args: string[]): Promise<CliResult> {
  const { runCli: taskRunCli } = await import('@domain/tasks/system/task-cli.js');
  return taskRunCli(args.length > 0 ? args : ['list']);
}

async function runInstallCli(args: string[]): Promise<CliResult> {
  const { runCli: installRunCli, getInstallHelp } = await import('@domain/system/install-cli.js');
  if (args.includes('--help') || args.includes('-h')) {
    return { exitCode: 0, stdout: getInstallHelp(), stderr: '' };
  }
  return installRunCli(args);
}

function runDaemonRestart(args: string[]): CliResult {
  if (args[1] === '--hard') return daemonRestartHardInternal(false);
  if (args[1] === '--force') return daemonRestartHardInternal(true);
  return daemonRestartInternal();
}

function runDaemonAction(args: string[]): Promise<CliResult> | CliResult | null {
  if (args[0] === 'stop') return stopDaemonInternal();
  if (args[0] === 'status') return getDaemonStatusInternal();
  if (args[0] === 'restart') return runDaemonRestart(args);
  return null;
}

async function runDaemonCli(args: string[]): Promise<CliResult> {
  const action = runDaemonAction(args);
  if (action) return action;
  if (args.includes('--help') || args.includes('-h')) {
    return { exitCode: 0, stdout: getCliHelp(), stderr: '' };
  }
  if (args.includes('--version') || args.includes('-V')) {
    return { exitCode: 0, stdout: `${CORTEX_VERSION}\n`, stderr: '' };
  }
  return { exitCode: 0, stdout: '', stderr: `'daemon' must be run from the main entry point, not imported.\nUse: node dist/entry/cli.js daemon` };
}

/** The host files a custom provider lives in: PI's own catalog and the gateway config it routes to. */
function defaultCustomProviderStores(): CustomProviderStores {
  return {
    modelsPath: USER_PI_MODELS_PATH,
    gatewayPath: GATEWAY_CONFIG_PATH,
    gatewayUrl: GATEWAY_URL,
  };
}

const CLI_HANDLERS: Record<string, CliHandler> = {
  init: (args) => runInitCli(args),
  config: () => ({ exitCode: 0, stdout: getConfigOutput(), stderr: '' }),
  auth: (args, deps) => runAuthCli(
    args,
    deps.getAuthStatus ?? getAuthStatus,
    deps.customProviderStores ?? defaultCustomProviderStores(),
  ),
  doctor: (args) => runDoctorCli(args),
  feishu: (args) => cmdFeishu(args),
  restart: () => runRestartCli(),
  'setup-gateway': (args) => runSetupGatewayCli(args),
  task: (args) => runTaskCli(args),
  install: (args) => runInstallCli(args),
  start: () => ({ exitCode: 0, stdout: '', stderr: `'start' must be run from the main entry point, not imported.\nUse: node dist/entry/cli.js start` }),
  daemon: (args) => runDaemonCli(args),
};

export async function runCli(argv: string[], deps: RunCliDeps = {}): Promise<CliResult> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { exitCode: 0, stdout: getCliHelp(), stderr: '' };
  }
  const handler = CLI_HANDLERS[argv[0]];
  if (!handler) {
    return { exitCode: 1, stdout: '', stderr: `Unknown command: '${argv[0]}'. Use --help to see available commands.` };
  }
  return handler(argv.slice(1), deps);
}

// ─── Main entry point (bin invocation) ─────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(getCliHelp());
    process.exit(0);
  }

  const cmd = args[0];
  const rest = args.slice(1);

  if (cmd === 'agent-run') {
    void import('@domain/agent-run/agent-run-cli.js')
      .then(({ runAgentRunCli }) => runAgentRunCli(rest))
      .then(code => { process.exitCode = code; })
      .catch((error) => {
        process.stderr.write(`${(error as Error)?.message ?? String(error)}\n`);
        process.exitCode = 1;
      });
    return;
  }

  // Handle --help / -h for subcommands
  if (rest.includes('--help') || rest.includes('-h')) {
    if (cmd === 'daemon') {
      console.log(getCliHelp());
      process.exit(0);
    }
    if (cmd === 'start') {
      console.log(getCliHelp());
      process.exit(0);
    }
    if (cmd === 'tui') {
      console.log(getTuiHelp());
      process.exit(0);
    }
    // Other subcommands (init, task, config, setup-gateway) handle --help internally via runCli()
  }

  // Handle --version / -V for subcommands
  if (rest.includes('--version') || rest.includes('-V')) {
    if (cmd === 'daemon') {
      console.log(CORTEX_VERSION);
      process.exit(0);
    }
  }

  // ── Subcommands that replace the process (fork + wait) ──
  if (cmd === 'start') {
    if (!existsSync(APP_JS)) {
      log.error(`Entry not found: ${APP_JS}`);
      log.error('Run `npm run build` first.');
      process.exit(1);
    }
    const child = fork(APP_JS, [], {
      cwd: DATA_DIR,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return; // let the event loop keep the process alive
  }

  if (cmd === 'daemon') {
    // restart-self: stop the running daemon, wait, then re-fork
    if (rest[0] === 'restart-self') {
      runCli(['daemon', 'stop']).then(async (stopResult) => {
        if (stopResult.stdout) console.log(stopResult.stdout);
        if (stopResult.stderr) console.error(stopResult.stderr);

        if (!existsSync(DAEMON_JS)) {
          log.error(`Entry not found: ${DAEMON_JS}`);
          log.error('Run `npm run build` first.');
          process.exit(1);
        }

        console.log('Starting daemon...');
        fork(DAEMON_JS, [], {
          cwd: DATA_DIR,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env },
        });
        process.exit(0);
      });
      return;
    }

    // Subcommands that don't fork: stop, status, restart — delegate to runCli
    if (rest[0] === 'stop' || rest[0] === 'status' || rest[0] === 'restart') {
      runCli(args).then((result) => {
        if (result.stdout) console.log(result.stdout);
        if (result.stderr) console.error(result.stderr);
        process.exit(result.exitCode);
      });
      return;
    }
    if (!existsSync(DAEMON_JS)) {
      log.error(`Entry not found: ${DAEMON_JS}`);
      log.error('Run `npm run build` first.');
      process.exit(1);
    }
    // Detach the daemon so it survives parent shell exit (Bug 1: EPIPE cascade).
    // detached: true → new process group leader; stdio: 'ignore' → no pipe to parent.
    // The daemon's own logger writes to files — console output is redundant.
    fork(DAEMON_JS, [], {
      cwd: DATA_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    process.exit(0);
  }

  // ── Subcommands that fork with stdio: 'inherit' ──
  if (cmd === 'tui') {
    cmdTui(rest);
    return;
  }

  // ── Subcommands that return results ──
  runCli(args).then((result) => {
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exit(result.exitCode);
  });
}

// ─── Export for testing & reuse ─────────────────────────────────

export { main };

if (isMainModule(import.meta.url)) {
  main();
}
