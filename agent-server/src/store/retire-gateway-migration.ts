// Before connections, the server ran an aistatus gateway as its child. A child outlives a server
// that is killed rather than stopped — the daemon SIGKILLs a server still running 5 s after
// SIGTERM, and stopping the gateway was the last step of a server's shutdown — and older servers
// even adopted such a gateway instead of starting their own. So after an upgrade one may still hold
// its port with nothing supervising it. This stops it, and only a process confirmed to be the
// gateway this install started: the one its pid file names, with that pid file and the gateway CLI
// on its command line; or, on Linux, one started before the pid file existed, recognised by the
// gateway CLI and this install's gateway.yaml on its command line and this install's home as its
// working directory.

import { readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { processCommandLine } from '@core/process-command-line.js';
import { isProcessAlive } from '@core/singleton-lock.js';
import { inTestProcess } from '@core/test-process.js';

const GATEWAY_CLI = 'gateway-cli';
const TERM_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;
const EXIT_POLL_MS = 100;

export interface RetireGatewayOptions {
  /** data/, where the gateway's pid file was written. */
  storeDir: string;
  /** The Cortex home: the working directory the server started its gateway in. */
  homeDir: string;
  /** The gateway.yaml the gateway was started with (`-c`). */
  gatewayConfigPath: string;
  platform?: NodeJS.Platform;
  commandLine?: (pid: number) => string | null;
  workingDir?: (pid: number) => string | null;
  /** Every running pid (Linux only). */
  listPids?: () => number[];
  isAlive?: (pid: number) => boolean;
  signal?: (pid: number, name: NodeJS.Signals) => void;
}

function readPid(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function procPids(): number[] {
  return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number);
}

function procWorkingDir(pid: number): string | null {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

function pidFileOf(options: RetireGatewayOptions): string {
  return path.join(options.storeDir, 'gateway.pid');
}

function recordedGateway(options: RetireGatewayOptions): number[] {
  const pidFile = pidFileOf(options);
  const pid = readPid(pidFile);
  const command = pid === null ? null : (options.commandLine ?? processCommandLine)(pid);
  return pid !== null && !!command?.includes(GATEWAY_CLI) && command.includes(pidFile) ? [pid] : [];
}

/** Gateways started before the pid file existed. Linux only: elsewhere they cannot be told apart. */
function unrecordedGateways(options: RetireGatewayOptions): number[] {
  if ((options.platform ?? process.platform) !== 'linux') return [];
  const commandLine = options.commandLine ?? processCommandLine;
  const workingDir = options.workingDir ?? procWorkingDir;
  const config = ` -c ${options.gatewayConfigPath}`;
  return (options.listPids ?? procPids)().filter((pid) => {
    const command = commandLine(pid);
    if (!command?.includes(GATEWAY_CLI) || !command.includes(config)) return false;
    return workingDir(pid) === path.resolve(options.homeDir);
  });
}

async function waitForExit(pid: number, isAlive: (pid: number) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
  }
  return true;
}

/** A test never signals a process it did not start: it must pass its own signaller. */
function signalProcess(pid: number, name: NodeJS.Signals): void {
  if (inTestProcess()) throw new Error(`refusing to signal pid ${pid} from a test process`);
  try { process.kill(pid, name); } catch { /* already gone */ }
}

async function stop(pid: number, options: RetireGatewayOptions): Promise<void> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const signal = options.signal ?? signalProcess;
  signal(pid, 'SIGTERM');
  if (await waitForExit(pid, isAlive, TERM_WAIT_MS)) return;
  signal(pid, 'SIGKILL');
  await waitForExit(pid, isAlive, KILL_WAIT_MS);
}

/** Stop any gateway this install left running; returns the pids it stopped. */
export async function retireGatewayChild(options: RetireGatewayOptions): Promise<number[]> {
  const pids = [...new Set([...recordedGateway(options), ...unrecordedGateways(options)])]
    .filter((pid) => pid !== process.pid);
  for (const pid of pids) await stop(pid, options);
  rmSync(pidFileOf(options), { force: true });
  return pids;
}
