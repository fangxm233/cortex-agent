import { WebSocketServer, WebSocket } from 'ws';
import * as crypto from 'crypto';
import { applyReportedGpuCount } from './machine-registry.js';
import { AUTH_HEADER, getClientToken, timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { claimStream, parseStreamId, cancelStreamsFor } from './reverse-stream.js';
import { emitCortexEvent } from '@core/hook-bus.js';

const log = createLogger('client-manager');

// --- Types ---

interface DeviceInfo {
  device: string;
  platform: string;
  capabilities: string[];
  connectedAt: Date;
  lastHeartbeat: Date;
  /** Client-reported bundle identity (hello). Null for clients outside the managed layout. */
  bundleHash: string | null;
  ws: WebSocket;
}

/** Client self-update wiring (set by client-hot-reload at boot). */
interface ClientUpdateHooks {
  /** A device said hello with its bundle hash — decide whether to push a bundle. */
  onHello: (device: string, bundleHash: string | null) => void;
  /** A device reported the outcome of an update install. */
  onUpdateResult: (device: string, result: { ok: boolean; hash?: string; error?: string }) => void;
}
let updateHooks: ClientUpdateHooks | null = null;
function setClientUpdateHooks(hooks: ClientUpdateHooks): void { updateHooks = hooks; }

/** Remote-client lifecycle wiring (set by client-lifecycle at load). */
interface HubLifecycleHooks {
  /** The hub is (re)starting to accept clients. */
  onStart: () => void;
  /** A device dropped off unexpectedly — bring its client back. */
  onDeviceGone: (device: string) => void;
  /** The hub is shutting down: cancel recovery and tear down routes. */
  onStop: () => Promise<void>;
}
let lifecycleHooks: HubLifecycleHooks | null = null;
function setHubLifecycleHooks(hooks: HubLifecycleHooks): void { lifecycleHooks = hooks; }

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
let clientManagerPort: number | null = null;

const HEARTBEAT_TIMEOUT_MS = 15_000; // 3 missed 5s heartbeats
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000; // 2 min for bash
const FILE_COMMAND_TIMEOUT_MS = 30_000; // 30s for file operations

function emitDisconnected(device: string, reason?: string): void {
  const payload = reason ? { device, reason } : { device };
  void emitCortexEvent('cortex:client.disconnected', payload).catch(() => {});
}

function rejectPendingFor(device: string, error: Error): void {
  for (const [id, pending] of pendingCommands) {
    if (pending.device !== device) continue;
    clearTimeout(pending.timer);
    pending.reject(error);
    pendingCommands.delete(id);
  }
}

/**
 * Take a device offline. Every path that notices a device is gone — socket close, heartbeat
 * timeout, a send that finds the socket no longer open — lands here, so nobody waits out a command
 * or stream-claim timeout for a device that just left, and recovery is always armed.
 */
function dropDevice(device: string, reason?: string): void {
  devices.delete(device);
  log.info(`Device disconnected: ${device}${reason ? ` (${reason})` : ''}`);
  emitDisconnected(device, reason);
  const dropped = cancelStreamsFor(device);
  if (dropped > 0) log.info(`cancelled ${dropped} pending reverse stream(s) for ${device}`);
  rejectPendingFor(device, new Error(`Device "${device}" disconnected${reason ? ` (${reason})` : ''}`));
  lifecycleHooks?.onDeviceGone(device);
}

/** The device's control socket, or throws (taking the device offline if its socket is gone). */
function openSocket(device: string): WebSocket {
  const info = devices.get(device);
  if (!info) throw new Error(`Device "${device}" is not online`);
  if (info.ws.readyState !== WebSocket.OPEN) {
    dropDevice(device, 'WebSocket is not open');
    throw new Error(`Device "${device}" WebSocket is not open`);
  }
  return info.ws;
}

/**
 * Take a device online from its hello frame. Returns the device name, or null when the frame was
 * rejected (no name / a live connection already holds that name) — the socket is closed in that case.
 *
 * The frame also carries the machine's own GPU count, which is reconciled into machines.json here:
 * a client knows its hardware, the registry only holds what someone typed. An absent or
 * unparseable `gpuCount` is "unknown" and leaves the configured value alone.
 */
function registerHelloDevice(ws: WebSocket, msg: any): string | null {
  const device: string | undefined = msg.device;
  if (!device) {
    ws.close(4001, 'Missing device name');
    return null;
  }
  const existing = devices.get(device);
  if (existing && existing.ws !== ws) {
    log.info(`Device ${device} already connected, rejecting new connection`);
    ws.close(4002, 'Device already connected');
    return null;
  }
  const bundleHash = typeof msg.bundleHash === 'string' && msg.bundleHash ? msg.bundleHash : null;
  const platform = msg.platform || 'unknown';
  devices.set(device, {
    device, platform, capabilities: msg.capabilities || [],
    connectedAt: new Date(), lastHeartbeat: new Date(), bundleHash, ws,
  });
  log.info(`Device connected: ${device} (${platform})`);
  void emitCortexEvent('cortex:client.connected', { device }).catch(() => {});
  applyReportedGpuCount(device, typeof msg.gpuCount === 'number' ? msg.gpuCount : null);
  try { updateHooks?.onHello(device, bundleHash); } catch (e) {
    log.warn(`onHello hook failed for ${device}: ${(e as Error).message}`);
  }
  return device;
}

// --- Server lifecycle ---

function startClientManager(port: number): void {
  if (wss) {
    log.warn('Already running');
    return;
  }

  clientManagerPort = port;
  lifecycleHooks?.onStart();

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

  wss.on('connection', (ws, req) => {
    // A reverse-stream callback rides this same port and token, distinguished only by path. It
    // carries raw bytes, never control JSON, so it must be handed off BEFORE the message loop —
    // and an unknown id is closed rather than trusted.
    const streamId = parseStreamId(req.url);
    if (streamId) {
      if (!claimStream(streamId, ws)) {
        log.warn('reverse callback with an unknown stream id — closing');
        ws.close(4004, 'Unknown stream');
      }
      return;
    }

    let deviceName: string | null = null;

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        deviceName = registerHelloDevice(ws, msg);
        return;
      }

      if (msg.type === 'update-result' && deviceName) {
        try {
          updateHooks?.onUpdateResult(deviceName, {
            ok: !!msg.ok,
            hash: typeof msg.hash === 'string' ? msg.hash : undefined,
            error: typeof msg.error === 'string' ? msg.error : undefined,
          });
        } catch (e) {
          log.warn(`onUpdateResult hook failed for ${deviceName}: ${(e as Error).message}`);
        }
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
    });

    ws.on('close', (_code, reason) => {
      if (deviceName && devices.get(deviceName)?.ws === ws) {
        dropDevice(deviceName, reason.toString().trim() || undefined);
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
      if (devices.get(name) !== info) continue;
      try { info.ws.close(4003, 'Heartbeat timeout'); } catch {}
      dropDevice(name, 'Heartbeat timeout');
    }
  }, 5000);

  wss.on('error', (err) => {
    log.error(`Server error: ${err.message}`);
  });
}

async function stopClientManager(): Promise<void> {
  if (heartbeatCheckInterval) clearInterval(heartbeatCheckInterval);
  heartbeatCheckInterval = null;

  for (const [id, pending] of pendingCommands) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Client manager shutting down'));
    pendingCommands.delete(id);
  }
  for (const [, info] of devices) {
    try { info.ws.close(1001, 'Server shutting down'); } catch {}
    emitDisconnected(info.device, 'Server shutting down');
  }
  devices.clear();

  const server = wss;
  wss = null;
  if (server) server.close();
  await lifecycleHooks?.onStop();
  clientManagerPort = null;
  if (server) log.info('WebSocket server stopped');
}

// --- Device queries ---

function getOnlineDevices(): Array<{ device: string; platform: string; connectedAt: Date; lastHeartbeat: Date; capabilities: string[]; bundleHash: string | null }> {
  const result: Array<{ device: string; platform: string; connectedAt: Date; lastHeartbeat: Date; capabilities: string[]; bundleHash: string | null }> = [];
  for (const [, info] of devices) {
    result.push({
      device: info.device,
      platform: info.platform,
      connectedAt: info.connectedAt,
      lastHeartbeat: info.lastHeartbeat,
      capabilities: info.capabilities,
      bundleHash: info.bundleHash,
    });
  }
  return result;
}

function isDeviceOnline(device: string): boolean {
  return devices.has(device);
}

/** The port the hub listens on, or null while it is stopped. */
function getClientManagerPort(): number | null {
  return clientManagerPort;
}

// --- Command routing ---

/**
 * Send one fire-and-forget JSON message over a device's control socket. `sendCommand` is a
 * request/response round trip; the reverse channel's `open-stream` has no reply on this socket at
 * all — the device answers by dialing a new WebSocket back, so there is nothing to await here.
 */
function sendControlMessage(device: string, message: Record<string, unknown>): void {
  openSocket(device).send(JSON.stringify(message));
}


function sendCommand(device: string, command: CommandParams): Promise<any> {
  let ws: WebSocket;
  try { ws = openSocket(device); } catch (err) { return Promise.reject(err); }

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
      ws.send(JSON.stringify({
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

export {
  startClientManager,
  stopClientManager,
  getOnlineDevices,
  isDeviceOnline,
  getClientManagerPort,
  sendCommand,
  sendControlMessage,
  setClientUpdateHooks,
  setHubLifecycleHooks,
};
