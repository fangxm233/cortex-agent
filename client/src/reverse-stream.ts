// input:  an open-stream request from the server
// output: an outbound callback WebSocket piped to a local TCP service
// pos:    Device half of the reverse channel — the direction NAT forbids
// >>> If I am updated, update me and the parent folder's CORTEX.md <<<

import * as net from 'net';
import WebSocket from 'ws';
import { createLogger } from './log.js';

const log = createLogger('reverse-stream');

/**
 * This client is outbound-only: the server cannot dial in. So when the server wants a TCP
 * connection to something on THIS machine, it asks over the control socket, and we open a new
 * outbound WebSocket back — one per connection, carrying raw bytes only.
 *
 * The callback reuses the control socket's URL and token, changing only the path: whatever route,
 * tunnel and credential already work for the control socket work here by construction.
 */
export interface OpenStreamMessage {
  type: 'open-stream';
  streamId: string;
  host: string;
  port: number;
}

export function isOpenStream(msg: unknown): msg is OpenStreamMessage {
  const m = msg as OpenStreamMessage;
  return !!m && m.type === 'open-stream'
    && typeof m.streamId === 'string'
    && typeof m.host === 'string'
    && Number.isInteger(m.port);
}

/**
 * Only loopback targets. The reverse channel exists to reach services running ON this device; a
 * device-relative hostname would turn every client into an open proxy into its LAN.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isAllowedTarget(host: string, port: number): boolean {
  return LOOPBACK.has(host.toLowerCase()) && port >= 1024 && port <= 65535;
}

/** `wss://host/path` → `wss://host/reverse?stream=<id>`; the control URL decides scheme and host. */
export function callbackUrl(controlUrl: string, streamId: string): string {
  const url = new URL(controlUrl);
  url.pathname = '/reverse';
  url.search = `stream=${encodeURIComponent(streamId)}`;
  return url.toString();
}

export interface ReverseStreamDeps {
  controlUrl: string;
  headers?: Record<string, string>;
  /** Injectable for tests. */
  connectWs?: (url: string, headers?: Record<string, string>) => WebSocket;
  connectTcp?: (host: string, port: number) => net.Socket;
}

/**
 * Serve one open-stream request. Errors are logged and the sockets closed: a failed stream must
 * never take the control connection down with it, because that would disconnect the whole device.
 */
export function openReverseStream(msg: OpenStreamMessage, deps: ReverseStreamDeps): void {
  if (!isAllowedTarget(msg.host, msg.port)) {
    log.warn(`refusing reverse stream to ${msg.host}:${msg.port} — only loopback ports ≥ 1024`);
    return;
  }
  const connectWs = deps.connectWs ?? ((url, headers) => new WebSocket(url, headers ? { headers } : undefined));
  const connectTcp = deps.connectTcp ?? ((host, port) => net.connect(port, host));

  const ws = connectWs(callbackUrl(deps.controlUrl, msg.streamId), deps.headers);
  const tcp = connectTcp(msg.host, msg.port);
  tcp.setNoDelay?.(true);

  let closed = false;
  const shutdown = (why: string): void => {
    if (closed) return;
    closed = true;
    log.info(`stream ${msg.streamId.slice(0, 8)} closed: ${why}`);
    try { ws.close(); } catch { /* already closing */ }
    try { tcp.destroy(); } catch { /* already destroyed */ }
  };

  ws.on('open', () => log.info(`stream ${msg.streamId.slice(0, 8)} → ${msg.host}:${msg.port}`));
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    // Pause the socket we are reading FROM until the write drains — otherwise a slow local service
    // buffers the whole transfer in memory.
    if (!tcp.write(buf)) {
      (ws as unknown as { pause?: () => void }).pause?.();
      tcp.once('drain', () => (ws as unknown as { resume?: () => void }).resume?.());
    }
  });
  ws.on('error', (e: Error) => shutdown(`ws error: ${e.message}`));
  ws.on('close', () => shutdown('ws closed'));

  tcp.on('data', (chunk: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    tcp.pause();
    ws.send(chunk, (err) => {
      if (err) shutdown(`send failed: ${err.message}`);
      else tcp.resume();
    });
  });
  tcp.on('error', (e: Error) => shutdown(`tcp error: ${e.message}`));
  tcp.on('close', () => shutdown('tcp closed'));
}
