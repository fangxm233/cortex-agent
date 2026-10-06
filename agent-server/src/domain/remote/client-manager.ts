import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import * as crypto from 'crypto';
import { applyReportedGpuCount } from './machine-registry.js';
import { AUTH_HEADER, getClientToken, timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { claimStream, parseStreamId, cancelStreamsFor } from './reverse-stream.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import type { ClientAction, ClientFrame, HelloFrame, ResultFrame, ServerFrame, UpdateResultFrame } from './client-protocol.js';

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
  action: ClientAction;
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
function registerHelloDevice(ws: WebSocket, msg: HelloFrame): string | null {
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

function parseClientFrame(raw: string): ClientFrame | null {
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg.type === 'string' ? msg as ClientFrame : null;
  } catch {
    return null;
  }
}

function settleCommand(frame: ResultFrame): void {
  const pending = frame.commandId ? pendingCommands.get(frame.commandId) : undefined;
  if (!pending) return;
  pendingCommands.delete(frame.commandId);
  clearTimeout(pending.timer);
  if (frame.success) pending.resolve(frame.data);
  else pending.reject(new Error(frame.error || 'Command failed'));
}

function reportUpdateResult(device: string, frame: UpdateResultFrame): void {
  try {
    updateHooks?.onUpdateResult(device, {
      ok: !!frame.ok,
      hash: typeof frame.hash === 'string' ? frame.hash : undefined,
      error: typeof frame.error === 'string' ? frame.error : undefined,
    });
  } catch (e) {
    log.warn(`onUpdateResult hook failed for ${device}: ${(e as Error).message}`);
  }
}

/** Every frame but hello; `device` is null until this socket has said hello. */
function onClientFrame(frame: Exclude<ClientFrame, HelloFrame>, device: string | null): void {
  if (frame.type === 'result') return settleCommand(frame);
  if (!device) return;
  if (frame.type === 'heartbeat') {
    const info = devices.get(device);
    if (info) info.lastHeartbeat = new Date();
  } else if (frame.type === 'update-result') {
    reportUpdateResult(device, frame);
  }
}

// --- Server lifecycle ---

/**
 * Authenticate at the HTTP upgrade (before the WS is established): the client must send a valid
 * bearer token in the `x-cortex-token` header. Fail-closed — an unset server token or a
 * missing/mismatched header rejects the upgrade with 401. This is the no-Cloudflare gate.
 */
function verifyClientToken(
  info: { req: IncomingMessage },
  cb: (ok: boolean, code?: number, message?: string) => void,
): void {
  const provided = info.req.headers[AUTH_HEADER];
  const headerVal = Array.isArray(provided) ? provided[0] : provided;
  if (timingSafeEqualStr(getClientToken(), headerVal)) return cb(true);
  const from = info.req.socket?.remoteAddress || 'unknown';
  log.warn(`WS auth rejected from ${from}: ${headerVal ? 'invalid token' : 'missing token'}`);
  cb(false, 401, 'Unauthorized');
}

function serveControlSocket(ws: WebSocket): void {
  let deviceName: string | null = null;

  ws.on('message', (raw) => {
    const frame = parseClientFrame(raw.toString());
    if (frame?.type === 'hello') deviceName = registerHelloDevice(ws, frame);
    else if (frame) onClientFrame(frame, deviceName);
  });

  ws.on('close', (_code, reason) => {
    if (deviceName && devices.get(deviceName)?.ws === ws) {
      dropDevice(deviceName, reason.toString().trim() || undefined);
    }
  });

  ws.on('error', (err) => {
    log.error(`WebSocket error for ${deviceName || 'unknown'}: ${err.message}`);
  });
}

function onConnection(ws: WebSocket, req: IncomingMessage): void {
  // A reverse-stream callback rides this same port and token, distinguished only by path. It
  // carries raw bytes, never control JSON, so it must be handed off BEFORE the message loop —
  // and an unknown id is closed rather than trusted.
  const streamId = parseStreamId(req.url);
  if (!streamId) return serveControlSocket(ws);
  if (!claimStream(streamId, ws)) {
    log.warn('reverse callback with an unknown stream id — closing');
    ws.close(4004, 'Unknown stream');
  }
}

/** Mark devices whose heartbeats stopped as offline. */
function evictStaleDevices(): void {
  const now = Date.now();
  const stale = [...devices.values()].filter((info) => now - info.lastHeartbeat.getTime() > HEARTBEAT_TIMEOUT_MS);
  for (const info of stale) {
    // Guard: only evict if entry hasn't been replaced by a reconnect
    if (devices.get(info.device) !== info) continue;
    try { info.ws.close(4003, 'Heartbeat timeout'); } catch {}
    dropDevice(info.device, 'Heartbeat timeout');
  }
}

function startClientManager(port: number): void {
  if (wss) {
    log.warn('Already running');
    return;
  }

  clientManagerPort = port;
  lifecycleHooks?.onStart();

  wss = new WebSocketServer({ port, verifyClient: verifyClientToken });
  log.info(`WebSocket server started on port ${port}`);
  wss.on('connection', onConnection);
  wss.on('error', (err) => {
    log.error(`Server error: ${err.message}`);
  });

  heartbeatCheckInterval = setInterval(evictStaleDevices, 5000);
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
function sendControlMessage(device: string, message: ServerFrame): void {
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
      const frame: ServerFrame = { type: 'command', commandId, action: command.action, params: command.params };
      ws.send(JSON.stringify(frame));
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
