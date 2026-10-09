import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getMachineRegistry, type MachineEntry, type MachineRegistry } from './machine-registry.js';
import { STORE_DIR, DATA_DIR, CONFIG_DIR } from '@core/paths.js';
import { getClientToken } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { getClientManagerPort, isDeviceOnline, setHubLifecycleHooks } from './client-manager.js';
import { SshTunnelSupervisor, reverseTunnelSpec, type SshTunnelSpec } from './client-ssh-tunnel.js';
import { sshExec } from './ssh-exec.js';
import { assertLocalClientMachine, completeLocalClientInstall, markLocalClientLaunchAttempted, readLocalClientIntent } from './local-client-install.js';
import { OwnedLocalLaunchGate, ownedLocalEnvironment } from './owned-local-launch.js';

// Remote client lifecycle: SSH nohup start, PID tracking, managed routes, auto-restart.

const log = createLogger('client-lifecycle');

type TunnelController = Pick<SshTunnelSupervisor, 'ensure' | 'stopAll' | 'resume' | 'release'>;
let tunnelSupervisor: TunnelController = new SshTunnelSupervisor();
const routeSnapshots = new Map<string, Pick<MachineEntry, 'ssh' | 'clientConnection' | 'clientReversePort'>>();

const PID_FILE = path.join(STORE_DIR, 'client-pids.json');
const ROUTE_OWNERSHIP_FILE = path.join(STORE_DIR, 'client-routes.json');
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RESTART_DELAY_MS = 60_000; // retry every 60s until device reconnects
const localPaths = { DATA_DIR, CONFIG_DIR };
let lifecycleStopped = false;
const localLaunch = new OwnedLocalLaunchGate({
  online: isDeviceOnline,
  recover: async (device, signal) => {
    assertLocalClientMachine(localPaths, _getRegistryImpl()[device]);
    await completeLocalClientInstall(localPaths, device, undefined, signal);
    return readLocalClientIntent(localPaths)?.launchAttempted;
  },
  markLaunchAttempted: (device, signal) => markLocalClientLaunchAttempted(localPaths, device, signal),
  launch: spawnOwnedLocalClient,
});

function loadPids(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return {}; }
}
function savePids(pids: Record<string, number>): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}
function getPid(device: string): number | undefined { return loadPids()[device]; }
function setPid(device: string, pid: number): void { const p = loadPids(); p[device] = pid; savePids(p); }
function deletePid(device: string): void { const p = loadPids(); delete p[device]; savePids(p); }

// --- Indirection so tests can swap the SSH executor and registry without spawning ssh ---
type SshExec = (host: string, command: string, timeout?: number) => Promise<string>;
let _sshExecImpl: SshExec = sshExec;
let _getRegistryImpl: () => MachineRegistry = getMachineRegistry;

/** Managed bundle entry for the same-machine client (shares the server's CORTEX home). */
function localClientEntryPath(): string {
  return path.join(DATA_DIR, 'client', 'current', 'client.mjs');
}

/** Default launch: node on the managed bundle. Shell/cmd expands the home variable. */
function defaultClientLaunch(reg: MachineEntry): string {
  return reg.win
    ? 'node "%USERPROFILE%\\.cortex\\client\\current\\client.mjs"'
    : 'node "$HOME/.cortex/client/current/client.mjs"';
}

/**
 * Build the shell command run over SSH to spawn cortex-client on a remote device.
 *
 * Windows note: WMI `Win32_Process.Create` does NOT perform PATH lookup, so the
 * launch is wrapped with `cmd.exe /c`, which resolves `node` and expands
 * `%USERPROFILE%`.
 *
 * Linux note: the shell handles PATH lookup; `nohup` detaches and `echo $!`
 * returns the child PID on stdout. Machines where `node` is not on the
 * non-interactive SSH PATH (nvm installs) set an absolute node path in
 * machines.json `clientCommand`.
 */
export function buildRemoteSpawnCommand(
  reg: MachineEntry,
  clientToken?: string,
  serverUrl?: string,
): string {
  const token = clientToken?.trim();
  const url = serverUrl?.trim();
  const launch = reg.clientCommand?.trim() || defaultClientLaunch(reg);
  if (reg.win) {
    const env = [
      token ? `set CORTEX_CLIENT_TOKEN=${token}` : '',
      url ? `set CORTEX_SERVER_URL=${url}` : '',
    ].filter(Boolean);
    const inner = `cmd.exe /c ${[...env, launch].join('&&')}`;
    return `powershell -Command "(Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList '${inner}').ProcessId"`;
  }
  const env = [
    token ? `CORTEX_CLIENT_TOKEN='${token}'` : '',
    url ? `CORTEX_SERVER_URL='${url}'` : '',
  ].filter(Boolean).join(' ');
  const envPrefix = env ? `${env} ` : '';
  return `${envPrefix}nohup ${launch} > /dev/null 2>&1 & echo $!`;
}

function loadRouteOwnership(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(ROUTE_OWNERSHIP_FILE, 'utf8')); } catch { return {}; }
}

function setRouteOwnership(device: string, route: string): void {
  const routes = loadRouteOwnership();
  routes[device] = route;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(ROUTE_OWNERSHIP_FILE, JSON.stringify(routes, null, 2));
}

function managedEntry(device: string): MachineEntry | undefined {
  const live = _getRegistryImpl()[device];
  if (!live) return undefined;
  let route = routeSnapshots.get(device);
  if (!route) {
    route = {
      ssh: live.ssh,
      clientConnection: live.clientConnection,
      clientReversePort: live.clientReversePort,
    };
    routeSnapshots.set(device, route);
  }
  return { ...live, ...route };
}

function managedServerUrl(reg: MachineEntry): string | undefined {
  if (reg.clientConnection !== 'ssh-reverse') return undefined;
  const port = getClientManagerPort();
  if (port === null) throw new Error('Client manager is not started');
  return `ws://127.0.0.1:${reg.clientReversePort ?? port}`;
}

function tunnelSpec(device: string, reg: MachineEntry): SshTunnelSpec | null {
  if (reg.clientConnection !== 'ssh-reverse') return null;
  const serverPort = getClientManagerPort();
  if (!reg.ssh || serverPort === null) throw new Error(`SSH reverse route is not ready for ${device}`);
  const remotePort = reg.clientReversePort ?? serverPort;
  return reverseTunnelSpec({ device, host: reg.ssh, remotePort, serverPort }, !!reg.win);
}

async function ensureManagedRoute(device: string, reg: MachineEntry): Promise<void> {
  const spec = tunnelSpec(device, reg);
  if (spec) await tunnelSupervisor.ensure(spec);
}

function expectedRouteOwnership(reg: MachineEntry): string {
  return managedServerUrl(reg) ?? 'direct';
}

async function stopMismatchedRemoteClient(device: string, reg: MachineEntry): Promise<void> {
  const pid = getPid(device);
  if (!pid || !reg.ssh) return;
  const owned = loadRouteOwnership()[device];
  const expected = expectedRouteOwnership(reg);
  if (owned === expected || (!owned && expected === 'direct')) return;
  const cmd = reg.win ? `taskkill /pid ${pid} /f /t 2>nul || echo ok` : `kill ${pid} 2>/dev/null || true`;
  await _sshExecImpl(reg.ssh, cmd, 10000);
  deletePid(device);
  log.info(`Stopped client on ${device} to switch route ${owned} → ${expected}`);
}

async function isRemotePidAlive(device: string): Promise<boolean> {
  const reg = managedEntry(device);
  if (!reg?.ssh) return false;
  const pid = getPid(device);
  if (!pid) return false;
  try {
    const cmd = reg.win
      ? `tasklist /fi "pid eq ${pid}" /fo csv /nh`
      : `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`;
    const result = await _sshExecImpl(reg.ssh, cmd);
    return reg.win ? result.includes(`"${pid}"`) : result.includes('alive');
  } catch {
    return false;
  }
}

async function launchRemoteClient(device: string): Promise<boolean> {
  const reg = managedEntry(device);
  if (!reg?.ssh) return false;
  await ensureManagedRoute(device, reg);
  const command = buildRemoteSpawnCommand(reg, getClientToken(), managedServerUrl(reg));
  const pidStr = await _sshExecImpl(reg.ssh, command, 30000);
  const pid = parseInt(pidStr);
  if (isNaN(pid) || pid <= 0) return false;
  setPid(device, pid);
  setRouteOwnership(device, expectedRouteOwnership(reg));
  log.info(`Started client on ${device} (PID ${pid})`);
  return true;
}

/**
 * Bring the device's route up and decide whether a launch is still needed: false when the client
 * is already connected or a previously launched one is alive and expected to reconnect.
 */
async function prepareLaunch(device: string, reg: MachineEntry): Promise<boolean> {
  await ensureManagedRoute(device, reg);
  if (isDeviceOnline(device)) return false;
  if (!reg.ssh) return true;
  await stopMismatchedRemoteClient(device, reg);
  if (!await isRemotePidAlive(device)) return true;
  log.info(`Client on ${device} already running (PID ${getPid(device)}), waiting for reconnect...`);
  return false;
}

/** Local device (no SSH): spawn the managed bundle on the server's own node. */
function spawnLocalClient(device: string): void {
  const entry = localClientEntryPath();
  if (!fs.existsSync(entry)) {
    log.warn(`Managed client bundle missing at ${entry} — skipping local client spawn on ${device}`);
    return;
  }
  try {
    const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      log.error(`Local client spawn error on ${device}: ${(err as Error).message}`);
    });
    child.unref();
    if (child.pid) {
      setPid(device, child.pid);
      log.info(`Started local client on ${device} (PID ${child.pid})`);
    }
  } catch (err) {
    log.error(`Failed to start local client on ${device}: ${(err as Error).message}`);
  }
}

function spawnOwnedLocalClient(device: string): void {
  assertLocalClientMachine(localPaths, _getRegistryImpl()[device]);
  const env = ownedLocalEnvironment(process.env, DATA_DIR, getClientToken(), getClientManagerPort());
  const child = spawn(process.execPath, [localClientEntryPath()], { detached: true, stdio: 'ignore', env });
  child.on('error', () => {
    log.error(`Owned local client spawn failed on ${device}; scheduling retry`);
    scheduleRestart(device);
  });
  child.unref();
  if (child.pid) setPid(device, child.pid);
}

function localIntentForRoute(reg: MachineEntry): ReturnType<typeof readLocalClientIntent> {
  try { return readLocalClientIntent(localPaths); }
  catch (error) {
    // Broken local state must fail closed locally, not disable an explicit external SSH route.
    if (reg.ssh) return null;
    throw error;
  }
}

async function startOwnedIfEnrolled(device: string, reg: MachineEntry): Promise<boolean> {
  const intent = localIntentForRoute(reg);
  if (!intent || (intent.device !== device && reg.ssh)) return false;
  if (intent.device !== device) throw new Error('Owned local bundle belongs to a different device');
  await localLaunch.start(device);
  if (!isDeviceOnline(device)) scheduleRestart(device);
  return true;
}

async function prepareAndStartClient(device: string, reg: MachineEntry): Promise<void> {
  if (await startOwnedIfEnrolled(device, reg)) return;
  if (!await prepareLaunch(device, reg)) return;
  if (!reg.ssh) return spawnLocalClient(device);
  await startRemoteWithRetry(device);
}

function isExternalDirectClient(reg: MachineEntry): boolean {
  // A direct-WS device at an external home cannot be launched via this server's local bundle.
  return !reg.ssh && !!reg.cortexPath?.trim() && path.resolve(reg.cortexPath) !== path.resolve(DATA_DIR);
}

export async function startRemoteClient(device: string): Promise<void> {
  const reg = managedEntry(device);
  if (!reg || lifecycleStopped || isExternalDirectClient(reg)) return;
  if (isDeviceOnline(device) && reg.clientConnection !== 'ssh-reverse') return;
  try {
    await prepareAndStartClient(device, reg);
  } catch (err) {
    log.error(`Failed to prepare client on ${device}: ${(err as Error).message} — scheduling retry`);
    scheduleRestart(device);
  }
}

/** Remote failures must keep the existing restart timer armed, including an unparseable PID. */
async function startRemoteWithRetry(device: string): Promise<void> {
  try {
    if (!await launchRemoteClient(device)) {
      log.warn(`Failed to parse PID for ${device} — scheduling retry`);
      scheduleRestart(device);
    }
  } catch (err) {
    log.error(`Failed to start client on ${device}: ${(err as Error).message} — scheduling retry`);
    scheduleRestart(device);
  }
}

function scheduleRestart(device: string): void {
  const reg = _getRegistryImpl()[device];
  if (!reg || lifecycleStopped || restartTimers.has(device)) return;

  const timer = setTimeout(async () => {
    restartTimers.delete(device);
    if (isDeviceOnline(device)) return; // already reconnected

    log.info(`Auto-restarting client on ${device}...`);
    try {
      await startRemoteClient(device);
    } catch (err) {
      log.error(`Restart failed for ${device}: ${(err as Error).message}`);
    }
    // If still offline, schedule another attempt
    if (!isDeviceOnline(device)) {
      scheduleRestart(device);
    }
  }, RESTART_DELAY_MS);

  restartTimers.set(device, timer);
}

function cancelRestarts(): void {
  for (const [, timer] of restartTimers) clearTimeout(timer);
  restartTimers.clear();
}

async function releaseDevice(device: string): Promise<void> {
  const timer = restartTimers.get(device);
  if (timer) clearTimeout(timer);
  restartTimers.delete(device);
  routeSnapshots.delete(device);
  await tunnelSupervisor.release(device);
  log.info(`Released ${device}: no longer in machines.json`);
}

/**
 * Drop what the manager still holds for machines that left the registry. A removed machine's
 * tunnel would otherwise keep retrying its frozen route until the server restarts. Pids and route
 * ownership stay on disk so a machine added back can adopt a client that is still running.
 */
export async function releaseUnregisteredDevices(): Promise<void> {
  const registry = _getRegistryImpl();
  const held = new Set([...routeSnapshots.keys(), ...restartTimers.keys()]);
  await Promise.all([...held].filter((device) => !registry[device]).map(releaseDevice));
}

/** Start clients on all registered devices and keep recovery armed until they connect. */
export async function startAllRemoteClients(): Promise<void> {
  for (const [device] of Object.entries(_getRegistryImpl())) {
    try {
      await startRemoteClient(device);
      if (!isDeviceOnline(device)) scheduleRestart(device);
    } catch (err) {
      log.error(`Failed to start ${device}: ${(err as Error).message}`);
      scheduleRestart(device);
    }
  }
}

// The hub reports its own start/stop and every unexpected departure here; registering at load keeps
// the hub free of any knowledge of SSH.
setHubLifecycleHooks({
  onStart: () => {
    lifecycleStopped = false;
    localLaunch.resume();
    tunnelSupervisor.resume();
  },
  onDeviceGone: scheduleRestart,
  onStop: async () => {
    lifecycleStopped = true;
    localLaunch.stop();
    cancelRestarts();
    await tunnelSupervisor.stopAll();
    routeSnapshots.clear();
  },
});

// --- Test hooks ---
// Tests override sshExec / registry to exercise spawn-failure and retry-scheduling
// paths without actually invoking the `ssh` binary. _testReset() must clear timers
// before module state leaks between tests.
export function _setSshExecForTesting(fn: SshExec): void { _sshExecImpl = fn; }
export function _setMachineRegistryProviderForTesting(fn: () => MachineRegistry): void { _getRegistryImpl = fn; }
export function _setTunnelSupervisorForTesting(supervisor: TunnelController): void { tunnelSupervisor = supervisor; }
export function _getRestartTimerCount(): number { return restartTimers.size; }
export function _testReset(): void {
  localLaunch.stop();
  localLaunch.resume();
  lifecycleStopped = false;
  cancelRestarts();
  routeSnapshots.clear();
  _sshExecImpl = sshExec;
  _getRegistryImpl = getMachineRegistry;
  tunnelSupervisor = new SshTunnelSupervisor();
}
