// input:  process argv, child processes, command modules
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
import { formatHelp } from '@core/cli-utils.js';
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

// ─── Paths ──────────────────────────────────────────────────────

const log = createLogger('cli');

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(MODULE_DIR, 'app.js');
const DAEMON_JS = path.join(MODULE_DIR, 'daemon.js');
const TUI_JS = path.join(MODULE_DIR, '..', 'tui', 'index.js');

// ─── Help ───────────────────────────────────────────────────────

export function getInitHelp(): string {
  return [
    'Initialize Cortex data directory',
    '',
    'Usage: cortex init [--home <path>] [--gateway-config-dir <path>]',
    '',
    'Creates the CORTEX_HOME directory structure, prompts for backends,',
    'interaction platform (Slack / Feishu), gateway usage, and system service.',
    'Generates .env with platform tokens, copies default configs, and',
    'auto-generates mcp-config.json and mode.json.',
    '',
    'Options:',
    '  --home <path>               Set CORTEX_HOME (default: $CORTEX_HOME or ~/.cortex/)',
    '  --gateway-config-dir <path>  Gateway config output directory (default: ~/.aistatus/)',
    '  --force                     Overwrite existing configs (.env, budget.json, mode.json, etc.)',
    '  --help, -h                  Show this help',
  ].join('\n');
}

export function getSetupGatewayHelp(): string {
  return [
    'Auto-detect Claude Code / PI configurations and generate gateway.yaml + profiles.json',
    '',
    'Usage: cortex setup-gateway [--dry-run] [--output-dir <path>]',
    '',
    'Discovers backend endpoints from local Claude Code and PI configs, then',
    'writes ~/.aistatus/gateway.yaml (with backup) and $CORTEX_HOME/config/profiles.json.',
    'Without flags, this command writes files in place.',
    '',
    'Options:',
    '  --dry-run               Print the generated gateway.yaml to stdout without writing anything',
    '  --output-dir <path>     Write gateway.yaml and profiles.json under <path> instead of the defaults',
    '  --help, -h              Show this help',
  ].join('\n');
}

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

export function getTuiHelp(): string {
  return [
    'Start the Cortex TUI (terminal UI) client',
    '',
    'Usage: cortex tui [options]',
    '',
    'Connects to a running Cortex daemon via WebSocket and opens',
    'a terminal-based chat interface.',
    '',
    'Options:',
    '  --resume              Open the resume-session picker on connect',
    '  --project <id>        Start a fresh session in the named project',
    '  --port <n>            Override TUI port (default: 3003, or CORTEX_TUI_PORT)',
    '  --help, -h            Show this help',
  ].join('\n');
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

export function getCliHelp(): string {
  return formatHelp({
    name: 'cortex',
    description: 'Cortex CLI — server management and initialization',
    usage: 'cortex <command> [options]',
    commands: [
      { name: 'init', description: 'Initialize CORTEX_HOME directory with configs and API keys' },
      { name: 'start', description: 'Start the Cortex server (node dist/entry/app.js)' },
      { name: 'daemon', description: 'Start daemon mode with file watching and auto-restart' },
      { name: 'daemon stop', description: 'Stop the running daemon gracefully (SIGTERM)' },
      { name: 'daemon status', description: 'Check daemon + child status (PID, uptime)' },
      { name: 'daemon restart', description: 'Graceful restart — signal daemon to drain and respawn app.js' },
      { name: 'daemon restart --hard', description: 'Hard restart — send SIGTERM directly to app.js (daemon auto-recovers)' },
      { name: 'daemon restart --force', description: 'Force restart — send SIGKILL immediately to app.js' },
      { name: 'daemon restart-self', description: 'Stop and restart the daemon process itself' },
      { name: 'restart', description: 'Legacy alias for daemon restart (touches $STORE_DIR/.restart)' },
      { name: 'task', description: 'Task system CLI (delegate to cortex-task)' },
      { name: 'agent-run', description: 'Run one supervised daemon-free Claude print turn' },
      { name: 'install latest', description: 'Install the latest version of Cortex from npm' },
      { name: 'config', description: 'Show resolved paths and initialization status' },
      { name: 'doctor', description: 'Health-check the install (runtime, login, platform, gateway); --fix to repair' },
      { name: 'feishu', description: 'Manage Feishu user-identity login (login / status / logout)' },
      { name: 'setup-gateway', description: 'Auto-detect Claude/PI configs and generate gateway.yaml + profiles.json' },
      { name: 'tui', description: 'Start the Terminal UI (TUI) client for local interaction' },
    ],
    options: [
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Interactive init', command: 'cortex init' },
      { description: 'Init to custom directory', command: 'cortex init --home /tmp/my-cortex' },
      { description: 'Show resolved paths', command: 'cortex config' },
      { description: 'Health-check the install', command: 'cortex doctor' },
      { description: 'Diagnose and auto-repair', command: 'cortex doctor --fix' },
      { description: 'Re-generate gateway config', command: 'cortex setup-gateway' },
      { description: 'Run a one-shot prompt', command: 'cortex agent-run --prompt-file prompt.txt --agent-slot parent --profile benchmark --cwd /workspace --output-format jsonl --events-file /logs/events.jsonl' },
      { description: 'Start the server', command: 'cortex start' },
      { description: 'Stop the daemon', command: 'cortex daemon stop' },
      { description: 'Check daemon status', command: 'cortex daemon status' },
      { description: 'Graceful restart', command: 'cortex daemon restart' },
      { description: 'Hard restart app.js', command: 'cortex daemon restart --hard' },
      { description: 'Restart daemon itself', command: 'cortex daemon restart-self' },
    ],
  });
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

// ─── runCli (synchronous/async commands) ────────────────────────

export async function runCli(argv: string[]): Promise<CliResult> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { exitCode: 0, stdout: getCliHelp(), stderr: '' };
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'init': {
      if (rest.includes('--help') || rest.includes('-h')) {
        return { exitCode: 0, stdout: getInitHelp(), stderr: '' };
      }
      const homeIndex = rest.indexOf('--home');
      const homeDir = homeIndex !== -1 && rest[homeIndex + 1] ? rest[homeIndex + 1] : undefined;
      const gatewayIndex = rest.indexOf('--gateway-config-dir');
      const gatewayConfigDir = gatewayIndex !== -1 && rest[gatewayIndex + 1] ? rest[gatewayIndex + 1] : undefined;
      const force = rest.includes('--force');
      try {
        await runInit({ homeDir, force, gatewayConfigDir });
        return { exitCode: 0, stdout: '', stderr: '' };
      } catch (err: any) {
        return { exitCode: 1, stdout: '', stderr: err.message || String(err) };
      }
    }

    case 'config':
      return { exitCode: 0, stdout: getConfigOutput(), stderr: '' };

    case 'doctor': {
      if (rest.includes('--help') || rest.includes('-h')) {
        return { exitCode: 0, stdout: getDoctorHelp(), stderr: '' };
      }
      return cmdDoctor(rest);
    }

    case 'feishu':
      return cmdFeishu(rest);

    case 'restart': {
      const trigger = path.join(STORE_DIR, '.restart');
      try {
        mkdirSync(STORE_DIR, { recursive: true });
        if (existsSync(trigger)) {
          const now = new Date();
          utimesSync(trigger, now, now);
        } else {
          writeFileSync(trigger, '');
        }
        return { exitCode: 0, stdout: `Restart trigger touched: ${trigger}\nIf a daemon is running it will drain and respawn app.js.\n`, stderr: '' };
      } catch (err: any) {
        return { exitCode: 1, stdout: '', stderr: `Could not write ${trigger}: ${err.message || String(err)}` };
      }
    }

    case 'setup-gateway': {
      if (rest.includes('--help') || rest.includes('-h')) {
        return { exitCode: 0, stdout: getSetupGatewayHelp(), stderr: '' };
      }
      const dryRun = rest.includes('--dry-run');
      const outDirIndex = rest.indexOf('--output-dir');
      const outputDir = outDirIndex !== -1 && rest[outDirIndex + 1] ? rest[outDirIndex + 1] : undefined;
      try {
        if (dryRun) {
          const yaml = dryRunGatewayYaml();
          return { exitCode: 0, stdout: yaml, stderr: '' };
        }
        const endpoints = discoverEndpoints();
        if (endpoints.length === 0) {
          return { exitCode: 0, stdout: 'No backends discovered. Log into Claude Code and/or PI first.\n', stderr: '' };
        }
        const { path: gatewayPath, result: mergeResult } = writeMergedGatewayYaml(endpoints, outputDir);
        const profilesPath = writeProfilesJson(endpoints, outputDir);
        const profiles = generateProfiles(endpoints);
        const profileNames = Object.keys(profiles.profiles).join(', ');
        const issues = validateProfilesAgainstGateway(mergeResult.endpoints, outputDir);
        const stdoutLines = [
          outputDir ? `[TEST MODE] Output directory: ${outputDir}` : '',
          `Gateway config: ${gatewayPath}`,
          `Profiles: ${profilesPath}`,
          `Discovered ${endpoints.length} endpoint modes`,
          `Generated profiles: ${profileNames} (default: ${profiles.defaultProfile})`,
        ];
        if (mergeResult.droppedFromDiscovery.length > 0) {
          const list = mergeResult.droppedFromDiscovery.map(p => `${p.mode}/${p.endpoint}`).join(', ');
          stdoutLines.push(`WARNING: preserved ${mergeResult.droppedFromDiscovery.length} existing gateway mode(s) not reported by discovery: ${list}`);
          stdoutLines.push('  (if these should auto-detect, check `pi /login` / `pi --list-models`)');
        }
        if (issues.length > 0) {
          stdoutLines.push(`WARNING: ${issues.length} profile(s) reference an unconfigured gateway mode (would fail with "Unknown mode"):`);
          for (const i of issues) stdoutLines.push(`  - ${i.profile}: ${i.reason}`);
        }
        return {
          exitCode: 0,
          stdout: stdoutLines.filter(Boolean).join('\n'),
          stderr: '',
        };
      } catch (err: any) {
        return { exitCode: 1, stdout: '', stderr: err.message || String(err) };
      }
    }

    case 'task': {
      const { runCli: taskRunCli } = await import('@domain/tasks/system/task-cli.js');
      return taskRunCli(rest.length > 0 ? rest : ['list']);
    }

    case 'install': {
      const { runCli: installRunCli, getInstallHelp } = await import('@domain/system/install-cli.js');
      if (rest.includes('--help') || rest.includes('-h')) {
        return { exitCode: 0, stdout: getInstallHelp(), stderr: '' };
      }
      return installRunCli(rest);
    }

    case 'start':
      return { exitCode: 0, stdout: '', stderr: `'start' must be run from the main entry point, not imported.\nUse: node dist/entry/cli.js start` };

    case 'daemon': {
      if (rest[0] === 'stop') {
        return stopDaemonInternal();
      }
      if (rest[0] === 'status') {
        return getDaemonStatusInternal();
      }
      if (rest[0] === 'restart') {
        if (rest[1] === '--hard') return daemonRestartHardInternal(false);
        if (rest[1] === '--force') return daemonRestartHardInternal(true);
        return daemonRestartInternal();
      }
      if (rest.includes('--help') || rest.includes('-h')) {
        return { exitCode: 0, stdout: getCliHelp(), stderr: '' };
      }
      if (rest.includes('--version') || rest.includes('-V')) {
        return { exitCode: 0, stdout: `${CORTEX_VERSION}\n`, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: `'daemon' must be run from the main entry point, not imported.\nUse: node dist/entry/cli.js daemon` };
    }

    default:
      return { exitCode: 1, stdout: '', stderr: `Unknown command: '${cmd}'. Use --help to see available commands.` };
  }
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
