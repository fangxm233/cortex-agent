// input:  cortex-client WebSockets, tasks, executions, machine registry
// output: client lifecycle, commands, fenced task callbacks
// pos:    Registers, routes and restarts remote clients
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { WebSocketServer, WebSocket } from 'ws';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { getMachineRegistry, type MachineEntry, type MachineRegistry } from '../tasks/dispatch-utils.js';
import { STORE_DIR, CONFIG_DIR } from '@core/utils.js';
import { AUTH_HEADER, getClientToken, timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import { readTasks, findTask } from '../tasks/system/task-lifecycle-edit.js';
import { taskMutator } from '../tasks/mutator.js';
import { setExecutionGpuByTaskId, type ExecutionGpuInfo } from '../executions/registry.js';

const log = createLogger('client-manager');

// --- Types ---

interface DeviceInfo {
  device: string;
  platform: string;
  capabilities: string[];
  connectedAt: Date;
  lastHeartbeat: Date;
  ws: WebSocket;
}

interface PendingCommand {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  device: string;
}

interface CommandParams {
  action: string;
  params: Record<string, any>;
  timeout?: number;
}

// --- State ---

const devices = new Map<string, DeviceInfo>();
const pendingCommands = new Map<string, PendingCommand>();
let wss: WebSocketServer | null = null;
let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;

const HEARTBEAT_TIMEOUT_MS = 15_000; // 3 missed 5s heartbeats
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000; // 2 min for bash
const FILE_COMMAND_TIMEOUT_MS = 30_000; // 30s for file operations

function emitDisconnected(device: string, reason?: string): void {
  const payload = reason ? { device, reason } : { device };
  void emitCortexEvent('cortex:client.disconnected', payload).catch(() => {});
}

// --- Server lifecycle ---

function startClientManager(port: number): void {
  if (wss) {
    log.warn('Already running');
    return;
  }

  // Authenticate at the HTTP upgrade (before the WS is established): the client must send a
  // valid bearer token in the `x-cortex-token` header. Fail-closed — an unset server token or
  // a missing/mismatched header rejects the upgrade with 401. This is the no-Cloudflare gate.
  wss = new WebSocketServer({
    port,
    verifyClient: (info, cb) => {
      const provided = info.req.headers[AUTH_HEADER];
      const headerVal = Array.isArray(provided) ? provided[0] : provided;
      if (timingSafeEqualStr(getClientToken(), headerVal)) {
        cb(true);
      } else {
        const from = info.req.socket?.remoteAddress || 'unknown';
        log.warn(`WS auth rejected from ${from}: ${headerVal ? 'invalid token' : 'missing token'}`);
        cb(false, 401, 'Unauthorized');
      }
    },
  });
  log.info(`WebSocket server started on port ${port}`);

  wss.on('connection', (ws) => {
    let deviceName: string | null = null;

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        deviceName = msg.device;
        if (!deviceName) {
          ws.close(4001, 'Missing device name');
          return;
        }

        // If a device with the same name is already connected, reject the new connection
        const existing = devices.get(deviceName);
        if (existing && existing.ws !== ws) {
          log.info(`Device ${deviceName} already connected, rejecting new connection`);
          ws.close(4002, 'Device already connected');
          return;
        }

        devices.set(deviceName, {
          device: deviceName,
          platform: msg.platform || 'unknown',
          capabilities: msg.capabilities || [],
          connectedAt: new Date(),
          lastHeartbeat: new Date(),
          ws,
        });
        log.info(`Device connected: ${deviceName} (${msg.platform || 'unknown'})`);
        void emitCortexEvent('cortex:client.connected', { device: deviceName }).catch(() => {});
        return;
      }

      if (msg.type === 'heartbeat' && deviceName) {
        const info = devices.get(deviceName);
        if (info) {
          info.lastHeartbeat = new Date();
        }
        return;
      }

      if (msg.type === 'result' && msg.commandId) {
        const pending = pendingCommands.get(msg.commandId);
        if (pending) {
          pendingCommands.delete(msg.commandId);
          clearTimeout(pending.timer);
          if (msg.success) {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(msg.error || 'Command failed'));
          }
        }
        return;
      }

      if (msg.type === 'task-callback') {
        void handleTaskCallback(ws, msg).catch((e) => log.error(`task-callback: ${(e as Error).message}`));
        return;
      }
    });

    ws.on('close', (_code, reason) => {
      if (deviceName) {
        const current = devices.get(deviceName);
        if (current && current.ws === ws) {
          log.info(`Device disconnected: ${deviceName}`);
          devices.delete(deviceName);
          emitDisconnected(deviceName, reason.toString().trim() || undefined);
          // Reject all pending commands for this device
          for (const [id, pending] of pendingCommands) {
            if (pending.device === deviceName) {
              clearTimeout(pending.timer);
              pending.reject(new Error(`Device "${deviceName}" disconnected`));
              pendingCommands.delete(id);
            }
          }
          // Auto-restart remote client
          scheduleRestart(deviceName);
        }
      }
    });

    ws.on('error', (err) => {
      log.error(`WebSocket error for ${deviceName || 'unknown'}: ${err.message}`);
    });
  });

  // Periodic heartbeat check — mark stale devices as offline
  heartbeatCheckInterval = setInterval(() => {
    const now = Date.now();
    const toEvict: Array<{ name: string; info: DeviceInfo }> = [];
    for (const [name, info] of devices) {
      if (now - info.lastHeartbeat.getTime() > HEARTBEAT_TIMEOUT_MS) {
        toEvict.push({ name, info });
      }
    }
    for (const { name, info } of toEvict) {
      // Guard: only evict if entry hasn't been replaced by a reconnect
      const current = devices.get(name);
      if (current && current.ws === info.ws) {
        log.info(`Device ${name} heartbeat timeout, marking offline`);
        try { info.ws.close(4003, 'Heartbeat timeout'); } catch {}
        devices.delete(name);
        emitDisconnected(name, 'Heartbeat timeout');
        // Reject pending commands for this device
        for (const [id, pending] of pendingCommands) {
          if (pending.device === name) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`Device "${name}" heartbeat timeout`));
            pendingCommands.delete(id);
          }
        }
        // Auto-restart remote client after heartbeat timeout
        scheduleRestart(name);
      }
    }
  }, 5000);

  wss.on('error', (err) => {
    log.error(`Server error: ${err.message}`);
  });
}

function stopClientManager(): void {
  if (heartbeatCheckInterval) {
    clearInterval(heartbeatCheckInterval);
    heartbeatCheckInterval = null;
  }

  // Reject all pending commands
  for (const [id, pending] of pendingCommands) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Client manager shutting down'));
    pendingCommands.delete(id);
  }

  // Close all connections
  for (const [, info] of devices) {
    try { info.ws.close(1001, 'Server shutting down'); } catch {}
    emitDisconnected(info.device, 'Server shutting down');
  }
  devices.clear();

  if (wss) {
    wss.close();
    wss = null;
    log.info('WebSocket server stopped');
  }
}

// --- Device queries ---

function getOnlineDevices(): Array<{ device: string; platform: string; connectedAt: Date; lastHeartbeat: Date; capabilities: string[] }> {
  const result: Array<{ device: string; platform: string; connectedAt: Date; lastHeartbeat: Date; capabilities: string[] }> = [];
  for (const [, info] of devices) {
    result.push({
      device: info.device,
      platform: info.platform,
      connectedAt: info.connectedAt,
      lastHeartbeat: info.lastHeartbeat,
      capabilities: info.capabilities,
    });
  }
  return result;
}

function isDeviceOnline(device: string): boolean {
  return devices.has(device);
}

// --- Command routing ---

function sendCommand(device: string, command: CommandParams): Promise<any> {
  const info = devices.get(device);
  if (!info) {
    return Promise.reject(new Error(`Device "${device}" is not online`));
  }

  if (info.ws.readyState !== WebSocket.OPEN) {
    devices.delete(device);
    emitDisconnected(device, 'WebSocket is not open');
    return Promise.reject(new Error(`Device "${device}" WebSocket is not open`));
  }

  const commandId = crypto.randomBytes(8).toString('hex');
  const timeoutMs = command.timeout || (
    command.action === 'bash' ? DEFAULT_COMMAND_TIMEOUT_MS : FILE_COMMAND_TIMEOUT_MS
  );

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error(`Command to "${device}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    pendingCommands.set(commandId, { resolve, reject, timer, device });

    try {
      info.ws.send(JSON.stringify({
        type: 'command',
        commandId,
        action: command.action,
        params: command.params,
      }));
    } catch (err) {
      pendingCommands.delete(commandId);
      clearTimeout(timer);
      reject(new Error(`Failed to send command to "${device}": ${(err as Error).message}`));
    }
  });
}

// --- Remote client lifecycle (SSH nohup start, PID tracking, auto-restart) ---

const PID_FILE = path.join(STORE_DIR, 'client-pids.json');
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RESTART_DELAY_MS = 60_000; // retry every 60s until device reconnects

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

// Keep in-memory alias for export compatibility
const clientPids = { get: getPid, set: setPid, delete: deletePid };

function sshExec(host: string, command: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', host, command], { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(`SSH error: ${err.message}\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

// --- Indirection so tests can swap the SSH executor and registry without spawning ssh ---
type SshExec = (host: string, command: string, timeout?: number) => Promise<string>;
let _sshExecImpl: SshExec = sshExec;
let _getRegistryImpl: () => MachineRegistry = getMachineRegistry;

/**
 * Build the shell command run over SSH to spawn cortex-client on a remote device.
 *
 * Windows note: WMI `Win32_Process.Create` does NOT perform PATH lookup, and
 * `cortex-client` installed by npm on Windows is a `.cmd` shim
 * (e.g. `C:\Users\<u>\AppData\Roaming\npm\cortex-client.cmd`). Passing the bare
 * name returns ReturnValue=9 (Path Not Found) with an empty ProcessId, which
 * over SSH serializes to "" and the parent caller logs
 * `Failed to parse PID for <device>: ""`. Wrapping with `cmd.exe /c` makes cmd
 * do the PATH lookup and run the .cmd shim correctly.
 *
 * Linux note: the shell handles PATH lookup; `nohup` detaches and `echo $!`
 * returns the child PID on stdout.
 */
function buildRemoteSpawnCommand(reg: MachineEntry, clientToken?: string): string {
  const token = clientToken?.trim();
  // Launch command is configurable per machine (machines.json `clientCommand`); defaults
  // to a bare `cortex-client`. Override for non-login-PATH cases, e.g. `bash -lc cortex-client`
  // on nvm machines so the login profile resolves node + cortex-client.
  const launch = reg.clientCommand?.trim() || 'cortex-client';
  if (reg.win) {
    // Inject the token via `cmd.exe /c set ... && <launch>` so the WMI-spawned process
    // sees CORTEX_CLIENT_TOKEN. Tokens are hex (no shell metacharacters), so no escaping needed.
    const inner = token
      ? `cmd.exe /c set CORTEX_CLIENT_TOKEN=${token} && ${launch}`
      : `cmd.exe /c ${launch}`;
    return `powershell -Command "(Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList '${inner}').ProcessId"`;
  }
  // Single-quote the token for the remote shell (hex value has no quotes to escape).
  const envPrefix = token ? `CORTEX_CLIENT_TOKEN='${token}' ` : '';
  return `${envPrefix}nohup ${launch} > /dev/null 2>&1 & echo $!`;
}

/**
 * Build the shell command run over SSH to install the client tgz on a remote device
 * during a dev-mode hot-reload.
 *
 * Defaults to a bare `npm install -g <tgz>`. Install command is configurable per machine
 * (machines.json `installCommand`) for hosts where `npm` is not on the non-interactive
 * SSH PATH — e.g. nvm installs, where node/npm are only sourced in a login/interactive
 * profile, so a plain `ssh host 'npm install -g …'` fails with "command not found".
 * The template may contain the `{tgz}` placeholder for the remote tgz path; if the
 * placeholder is absent, the path is appended. Examples of an override:
 *   "bash -lc 'source ~/.nvm/nvm.sh && npm install -g {tgz}'"
 *   "/home/u/.nvm/versions/node/v20.19.5/bin/npm install -g"
 */
function buildRemoteInstallCommand(reg: MachineEntry, remoteTgzPath: string): string {
  const tmpl = reg.installCommand?.trim();
  if (!tmpl) return `npm install -g ${remoteTgzPath}`;
  return tmpl.includes('{tgz}')
    ? tmpl.replaceAll('{tgz}', remoteTgzPath)
    : `${tmpl} ${remoteTgzPath}`;
}

async function isRemotePidAlive(device: string): Promise<boolean> {
  const reg = _getRegistryImpl()[device];
  if (!reg?.ssh) return false;
  const pid = clientPids.get(device);
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

async function startRemoteClient(device: string): Promise<void> {
  const reg = _getRegistryImpl()[device];
  if (!reg) return;

  // Check if already online via WebSocket
  if (devices.has(device)) return;

  // Check if existing PID still alive
  if (reg.ssh && await isRemotePidAlive(device)) {
    log.info(`Client on ${device} already running (PID ${clientPids.get(device)}), waiting for reconnect...`);
    return;
  }

  // Local device (no SSH): spawn cortex-client (config managed by LLM)
  if (!reg.ssh) {
    try {
      const child = spawn('cortex-client', [], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          log.warn(`cortex-client binary not found on PATH — skipping local client spawn on ${device} (install with: npm i -g cortex-client)`);
        } else {
          log.error(`Local client spawn error on ${device}: ${e.message}`);
        }
      });
      child.unref();
      if (child.pid) {
        clientPids.set(device, child.pid);
        log.info(`Started local client on ${device} (PID ${child.pid})`);
      }
    } catch (err) {
      log.error(`Failed to start local client on ${device}: ${(err as Error).message}`);
    }
    return;
  }

  // Remote device: launch cortex-client (config managed by LLM, written once at bootstrap).
  // On ANY failure path (SSH error, empty/unparseable PID), we MUST schedule a retry —
  // otherwise a single startup failure leaves the device offline until the next server
  // restart, because scheduleRestart() is otherwise only triggered by disconnect or
  // heartbeat-timeout of an already-connected device.
  try {
    const pidStr = await _sshExecImpl(reg.ssh, buildRemoteSpawnCommand(reg, getClientToken()), 30000);
    const pid = parseInt(pidStr);
    if (!isNaN(pid) && pid > 0) {
      clientPids.set(device, pid);
      log.info(`Started client on ${device} (PID ${pid})`);
    } else {
      log.warn(`Failed to parse PID for ${device}: "${pidStr}" — scheduling retry`);
      scheduleRestart(device);
    }
  } catch (err) {
    log.error(`Failed to start client on ${device}: ${(err as Error).message} — scheduling retry`);
    scheduleRestart(device);
  }
}

function scheduleRestart(device: string): void {
  const reg = _getRegistryImpl()[device];
  if (!reg || restartTimers.has(device)) return;

  const timer = setTimeout(async () => {
    restartTimers.delete(device);
    if (devices.has(device)) return; // already reconnected

    log.info(`Auto-restarting client on ${device}...`);
    try {
      await startRemoteClient(device);
    } catch (err) {
      log.error(`Restart failed for ${device}: ${(err as Error).message}`);
    }
    // If still offline, schedule another attempt
    if (!devices.has(device)) {
      scheduleRestart(device);
    }
  }, RESTART_DELAY_MS);

  restartTimers.set(device, timer);
}

/** Start clients on all registered devices */
async function startAllRemoteClients(): Promise<void> {
  for (const [device] of Object.entries(_getRegistryImpl())) {
    try {
      await startRemoteClient(device);
    } catch (err) {
      log.error(`Failed to start ${device}: ${(err as Error).message}`);
    }
  }
}

// --- Test hooks ---
// Tests override sshExec / registry to exercise spawn-failure and retry-scheduling
// paths without actually invoking the `ssh` binary. _testReset() must clear timers
// before module state leaks between tests.
function _setSshExecForTesting(fn: SshExec): void { _sshExecImpl = fn; }
function _setMachineRegistryProviderForTesting(fn: () => MachineRegistry): void { _getRegistryImpl = fn; }
function _getRestartTimerCount(): number { return restartTimers.size; }
function _testReset(): void {
  for (const [, timer] of restartTimers) clearTimeout(timer);
  restartTimers.clear();
  _sshExecImpl = sshExec;
  _getRegistryImpl = getMachineRegistry;
}

// --- Task callback handler (DR-0011 §4.4) ---

function sendAck(ws: WebSocket, callbackId: string, ok: boolean, message?: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'task-callback-ack', callbackId, ok, message }));
  }
}

/** Validate an untrusted `gpu` field from a task-callback into a persistable ExecutionGpuInfo,
 *  or null if absent/malformed. Requires a non-empty numeric `indices` array. */
function normalizeGpuPayload(raw: unknown): ExecutionGpuInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const indices = Array.isArray(obj.indices)
    ? obj.indices.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  if (indices.length === 0) return null;
  const memoryMb = typeof obj.memoryMb === 'number' && Number.isFinite(obj.memoryMb) ? obj.memoryMb : null;
  return { indices, memoryMb };
}

async function handleTaskCallback(ws: WebSocket, msg: any): Promise<void> {
  const { taskProject, taskId, dispatchGeneration, termination, exitCode, durationHuman,
          remoteResultPath, remoteLogPath, device, callbackId, logTail, gpu } = msg;

  // Capture the per-execution GPU onto the dispatch execution record (DR-0018 §6.3 B2-followup).
  // Keyed by taskId, independent of task status, and done BEFORE the idempotency short-circuits so
  // it lands even on an "already done" callback. No-op when no execution is registered for the task
  // (non-webhook-launched run) or the payload is absent/malformed.
  if (taskId) {
    const normalizedGpu = normalizeGpuPayload(gpu);
    if (normalizedGpu) {
      try { setExecutionGpuByTaskId(taskId, normalizedGpu); }
      catch (e) { log.warn(`task-callback: failed to record GPU for task ${taskId}: ${(e as Error).message}`); }
    }
  }

  // No task linkage: ack-true immediately (client doesn't need to retry)
  if (!taskProject || !taskId) {
    sendAck(ws, callbackId, true, 'no task linkage');
    return;
  }

  // Read task state from TASKS.yaml for idempotency check
  const tasks = readTasks(taskProject);
  const found = findTask(tasks, null, taskId);

  if ('error' in found) {
    log.info(`Ghost callback: task ${taskId} not found in ${taskProject}`);
    sendAck(ws, callbackId, true, 'ghost callback');
    return;
  }

  const task = found.task;
  if (task.status === 'done') {
    sendAck(ws, callbackId, true, 'already done, idempotent');
    return;
  }

  const isSuccess = termination === 'completed' && exitCode === 0;
  const remoteRef = remoteResultPath || remoteLogPath || 'unknown';
  const note = isSuccess
    ? `cortex-run on ${device} completed in ${durationHuman || '?'}, exit 0. Remote: ${remoteRef}`
    : `cortex-run on ${device} ${termination || '?'} after ${durationHuman || '?'}, exit ${exitCode ?? '?'}. Remote: ${remoteRef}\n--- log tail ---\n${logTail || '(no log tail)'}`;

  // Route through taskMutator (not the bare lifecycle functions) so task.completed /
  // task.blocked events fire — a manager thread suspended on this task (DR-0014 §8)
  // is woken by exactly these events, possibly days after dispatch.
  let result: any;
  if (isSuccess) {
    result = await taskMutator.complete(taskId, note, {
      skipVerify: true,
      skipVerifyReason: 'remote-run',
      ownership: { generation: dispatchGeneration ?? null },
    });
  } else {
    result = await taskMutator.block(taskId, note, {
      ownership: { generation: dispatchGeneration ?? null },
    });
  }

  const ackMessage = result.verify_warning
    ? `${result.message} (${result.verify_warning})`
    : result.message;
  sendAck(ws, callbackId, result.stale ? true : result.success, ackMessage);
}

export {
  startClientManager,
  stopClientManager,
  getOnlineDevices,
  isDeviceOnline,
  sendCommand,
  startRemoteClient,
  startAllRemoteClients,
  buildRemoteSpawnCommand,
  buildRemoteInstallCommand,
  clientPids,
  sshExec,
  // Test-only hooks (prefixed with _ by convention).
  _setSshExecForTesting,
  _setMachineRegistryProviderForTesting,
  _getRestartTimerCount,
  _testReset,
};
