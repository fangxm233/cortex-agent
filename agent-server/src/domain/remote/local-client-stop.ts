import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CONFIG_DIR, DATA_DIR } from '@core/paths.js';
import { isProcessAlive } from '@core/singleton-lock.js';
import { processCommandLine } from '@core/process-command-line.js';
import type { MachineRegistry } from './machine-registry.js';
import { deleteClientPid, isLocalLaunchMachine, loadClientPids, localClientEntryPath } from './client-pids.js';
import { markLocalClientStopped, readLocalClientIntent } from './local-client-install.js';

// Stopping the daemon also stops the client it launched on this machine. The daemon does not own
// that process (it is detached, and on Windows the daemon itself is terminated without running any
// handler), so `cortex daemon stop` does it once the daemon is gone.

export type LocalClientStopOutcome =
  /** It ran this home's client and has exited. */
  | 'stopped'
  /** The recorded process had already exited. */
  | 'not-running'
  /** The PID now belongs to another program; left alone. */
  | 'reused'
  /** Its command line could not be read; left alone. */
  | 'unverified'
  /** Still alive after a forced kill. */
  | 'survived';

export interface LocalClientStop { device: string; pid: number; outcome: LocalClientStopOutcome }

export interface LocalClientStopDeps {
  platform: NodeJS.Platform;
  registry(): MachineRegistry;
  alive(pid: number): boolean;
  commandLine(pid: number): string | null;
  /** Ask it to exit (POSIX SIGTERM; Windows has no graceful signal and kills the tree). */
  terminate(pid: number): void;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
}

const STOP_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const POLL_MS = 100;

function windowsKillTree(pid: number): void {
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

/** machines.json read directly: loading the registry module would log its startup banner. */
function readMachines(): MachineRegistry {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'machines.json'), 'utf8')); } catch { return {}; }
}

const DEFAULT_DEPS: LocalClientStopDeps = {
  platform: process.platform,
  registry: readMachines,
  alive: isProcessAlive,
  commandLine: processCommandLine,
  terminate: (pid) => process.platform === 'win32' ? windowsKillTree(pid) : void process.kill(pid, 'SIGTERM'),
  kill: (pid) => process.platform === 'win32' ? windowsKillTree(pid) : void process.kill(pid, 'SIGKILL'),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Whether a command line runs this home's client bundle (Windows paths compare case-insensitively). */
export function runsLocalClientEntry(commandLine: string, entry: string, platform: NodeJS.Platform): boolean {
  const normalize = (text: string) => platform === 'win32' ? text.replace(/\//g, '\\').toLowerCase() : text;
  return normalize(commandLine).includes(normalize(entry));
}

async function exitsWithin(pid: number, ms: number, deps: LocalClientStopDeps): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += POLL_MS) {
    if (!deps.alive(pid)) return true;
    await deps.sleep(POLL_MS);
  }
  return !deps.alive(pid);
}

async function stopClientProcess(pid: number, deps: LocalClientStopDeps): Promise<LocalClientStopOutcome> {
  if (!deps.alive(pid)) return 'not-running';
  const commandLine = deps.commandLine(pid);
  if (commandLine === null) return deps.alive(pid) ? 'unverified' : 'not-running';
  if (!runsLocalClientEntry(commandLine, localClientEntryPath(), deps.platform)) return 'reused';
  try { deps.terminate(pid); } catch { /* exited meanwhile, or the forced kill below decides */ }
  if (await exitsWithin(pid, STOP_GRACE_MS, deps)) return 'stopped';
  try { deps.kill(pid); } catch { /* checked below */ }
  return await exitsWithin(pid, KILL_GRACE_MS, deps) ? 'stopped' : 'survived';
}

/** With the owned client known to be gone, the next start need not wait for it to reconnect. */
async function releaseOwnedLaunch(stops: LocalClientStop[]): Promise<void> {
  const paths = { DATA_DIR, CONFIG_DIR };
  let device: string | undefined;
  try { device = readLocalClientIntent(paths)?.device; } catch { return; }
  const owned = stops.find((stop) => stop.device === device);
  if (!device || !owned || !['stopped', 'not-running', 'reused'].includes(owned.outcome)) return;
  await markLocalClientStopped(paths, device).catch(() => {});
}

/**
 * Stop every client this home launched as a local process: the owned local client and the legacy
 * local spawn, found through their recorded PIDs. A PID is signalled only while its command line
 * still runs this home's client bundle; clients of SSH, SSH-reverse and custom-command machines are
 * never touched. Records of clients that are gone are dropped, so the next daemon start launches a
 * fresh client through the normal path.
 */
export async function stopLaunchedLocalClients(deps: LocalClientStopDeps = DEFAULT_DEPS): Promise<LocalClientStop[]> {
  const registry = deps.registry();
  const stops: LocalClientStop[] = [];
  for (const [device, pid] of Object.entries(loadClientPids())) {
    if (!isLocalLaunchMachine(registry[device]) || !Number.isInteger(pid) || pid <= 0) continue;
    const outcome = await stopClientProcess(pid, deps);
    if (outcome !== 'unverified' && outcome !== 'survived') deleteClientPid(device);
    stops.push({ device, pid, outcome });
  }
  await releaseOwnedLaunch(stops);
  return stops;
}
