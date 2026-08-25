// input:  a device name and a port on that device
// output: a loopback listener on THIS server whose bytes come out on the device
// pos:    Server half of the reverse channel — makes a remote port look local
// >>> If I am updated, update CORTEX.md <<<

import * as net from 'net';
import type { WebSocket } from 'ws';
import { createLogger } from '@core/log.js';
import { requestStream } from './reverse-stream.js';
import { sendControlMessage } from './client-manager.js';

const log = createLogger('device-port');

/**
 * Why a real local socket at all (plan/embedded-browser.md §18.1): the consumer is Playwright,
 * which takes a `--cdp-endpoint` URL, does `GET /json/version`, then opens a WebSocket. It needs
 * something it can dial. So the server binds a loopback port and every byte written to it comes
 * out of a TCP connection on the device — no CDP awareness anywhere in the path, which is what
 * makes the same tunnel serve TensorBoard, Jupyter and dashboards for free.
 */

/** Only loopback: this port is a private handle for server-side processes, not a public relay. */
const BIND_ADDRESS = '127.0.0.1';

/** Bound so a leaking caller cannot exhaust file descriptors with listeners. */
const MAX_PORTS = 32;

/** Bound per mapping, mirroring the desktop forward's own cap. */
const MAX_CONNECTIONS_PER_PORT = 64;

export interface DevicePort {
  device: string;
  /** Host as seen FROM the device — always loopback there. */
  remoteHost: string;
  remotePort: number;
  /** Port on this server. Dial this and you reach `remoteHost:remotePort` on `device`. */
  localPort: number;
  openedAt: Date;
}

interface Entry {
  info: DevicePort;
  server: net.Server;
  connections: Set<net.Socket>;
}

const ports = new Map<string, Entry>();

function key(device: string, host: string, port: number): string {
  return `${device}|${host}|${port}`;
}

/**
 * Pump bytes between an accepted TCP connection and the device's callback socket. Each side pauses
 * while the other drains, so a slow consumer costs latency rather than server memory.
 */
function pipeStream(tcp: net.Socket, ws: WebSocket, label: string): void {
  let closed = false;
  const shutdown = (why: string): void => {
    if (closed) return;
    closed = true;
    log.debug(`${label} closed: ${why}`);
    try { ws.close(); } catch { /* already closing */ }
    try { tcp.destroy(); } catch { /* already destroyed */ }
  };

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (!tcp.write(buf)) {
      (ws as unknown as { pause?: () => void }).pause?.();
      tcp.once('drain', () => (ws as unknown as { resume?: () => void }).resume?.());
    }
  });
  ws.on('error', (e: Error) => shutdown(`ws error: ${e.message}`));
  ws.on('close', () => shutdown('ws closed'));

  tcp.on('data', (chunk: Buffer) => {
    tcp.pause();
    ws.send(chunk, (err?: Error) => {
      if (err) shutdown(`send failed: ${err.message}`);
      else tcp.resume();
    });
  });
  tcp.on('error', (e: Error) => shutdown(`tcp error: ${e.message}`));
  tcp.on('close', () => shutdown('tcp closed'));

  tcp.resume();
}

/** Injectable so tests can drive the handshake without a live device. */
let sendControl: (device: string, message: Record<string, unknown>) => void = sendControlMessage;

export function _setControlSenderForTesting(
  fn: ((device: string, message: Record<string, unknown>) => void) | null,
): void {
  sendControl = fn ?? sendControlMessage;
}

/**
 * Serve one accepted connection: ask the device to dial back, wait for its callback socket, then
 * hand the two to the pump. The connection is held paused until the pairing succeeds so no byte
 * the client already sent is dropped.
 */
async function serveConnection(entry: Entry, tcp: net.Socket): Promise<void> {
  const { device, remoteHost, remotePort } = entry.info;
  tcp.pause();
  tcp.setNoDelay(true);
  entry.connections.add(tcp);
  tcp.once('close', () => entry.connections.delete(tcp));

  if (entry.connections.size > MAX_CONNECTIONS_PER_PORT) {
    log.warn(`${device}:${remotePort} — connection cap reached, refusing`);
    tcp.destroy();
    return;
  }

  let req: ReturnType<typeof requestStream>;
  try {
    req = requestStream(device, remoteHost, remotePort);
  } catch (err) {
    log.warn(`${device}:${remotePort} — ${(err as Error).message}`);
    tcp.destroy();
    return;
  }

  try {
    sendControl(device, req.message);
  } catch (err) {
    log.warn(`${device}:${remotePort} — cannot ask device to open a stream: ${(err as Error).message}`);
    tcp.destroy();
    return;
  }

  let ws: WebSocket;
  try {
    ws = await req.socket;
  } catch (err) {
    log.warn(`${device}:${remotePort} — ${(err as Error).message}`);
    tcp.destroy();
    return;
  }

  // The client may have hung up while we were waiting for the device to dial back.
  if (tcp.destroyed) {
    try { ws.close(); } catch { /* already closing */ }
    return;
  }

  pipeStream(tcp, ws, `${device}:${remotePort} stream ${req.id.slice(0, 8)}`);
}

export interface OpenDevicePortOptions {
  /** Host as resolved ON the device. Loopback only — enforced again by the client. */
  remoteHost?: string;
}

/**
 * Map `remotePort` on `device` onto a fresh loopback port here.
 *
 * Idempotent per (device, host, port): asking twice returns the same mapping rather than leaking a
 * second listener, because callers (an agent turn, a UI panel) come and go independently and
 * neither can know whether the other already opened it.
 */
export async function openDevicePort(
  device: string,
  remotePort: number,
  opts: OpenDevicePortOptions = {},
): Promise<DevicePort> {
  const remoteHost = opts.remoteHost ?? '127.0.0.1';
  const k = key(device, remoteHost, remotePort);
  const existing = ports.get(k);
  if (existing) return existing.info;

  if (ports.size >= MAX_PORTS) {
    throw new Error(`too many device ports open (${ports.size})`);
  }

  const server = net.createServer();
  const entry: Entry = {
    info: { device, remoteHost, remotePort, localPort: 0, openedAt: new Date() },
    server,
    connections: new Set(),
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the OS picks. A fixed port would collide with whatever else runs on this host, and
    // nothing outside this process needs to guess the number — callers are handed it.
    server.listen(0, BIND_ADDRESS, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('failed to bind a local port');
  }
  entry.info.localPort = addr.port;

  server.on('connection', (tcp) => { void serveConnection(entry, tcp); });
  server.on('error', (err) => log.warn(`listener for ${device}:${remotePort} failed: ${err.message}`));

  ports.set(k, entry);
  log.info(`device port ${BIND_ADDRESS}:${addr.port} → ${device} ${remoteHost}:${remotePort}`);
  return entry.info;
}

/** Tear down a mapping and every connection riding it. */
export function closeDevicePort(device: string, remotePort: number, remoteHost = '127.0.0.1'): boolean {
  const k = key(device, remoteHost, remotePort);
  const entry = ports.get(k);
  if (!entry) return false;
  ports.delete(k);
  for (const sock of entry.connections) sock.destroy();
  entry.connections.clear();
  entry.server.close();
  log.info(`closed device port ${entry.info.localPort} → ${device} ${remoteHost}:${remotePort}`);
  return true;
}

/** Close every mapping for one device. */
export function closeDevicePortsFor(device: string): number {
  let closed = 0;
  for (const entry of [...ports.values()]) {
    if (entry.info.device !== device) continue;
    if (closeDevicePort(entry.info.device, entry.info.remotePort, entry.info.remoteHost)) closed++;
  }
  return closed;
}

export function listDevicePorts(): DevicePort[] {
  return [...ports.values()].map((e) => ({ ...e.info }));
}

export function stopAllDevicePorts(): void {
  for (const entry of [...ports.values()]) {
    closeDevicePort(entry.info.device, entry.info.remotePort, entry.info.remoteHost);
  }
}
