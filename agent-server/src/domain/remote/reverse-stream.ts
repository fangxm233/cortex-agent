// input:  requests for a TCP connection on a remote device, and the callback sockets it dials back
// output: byte-transparent streams from the server to any cortex-client device
// pos:    Reverse half of the port forward — the direction NAT forbids
// >>> If I am updated, update CORTEX.md <<<

import * as crypto from 'crypto';
import type { WebSocket } from 'ws';
import { createLogger } from '@core/log.js';

const log = createLogger('reverse-stream');

/**
 * A cortex-client is outbound-only: the server can never dial INTO a device (plan §18). So the
 * server asks over the existing control socket, and the device opens a NEW outbound WebSocket back
 * — one per connection, no multiplexing. Per-connection sockets reuse the exact model the desktop
 * port forward already proved; multiplexing over the single control socket would mean re-inventing
 * per-stream flow control, which is the expensive part.
 *
 * The callback rides the SAME port and token as the control socket, distinguished only by path:
 * a device that can reach its hub can already reach this, so no new tunnel, port or credential
 * enters the picture.
 */
export const REVERSE_PATH_PREFIX = '/reverse';

/** A device that never dials back must not pin a socket forever. */
const CLAIM_TIMEOUT_MS = 10_000;

/** Bound so a misbehaving device cannot exhaust memory with unclaimed requests. */
const MAX_PENDING = 64;

interface Pending {
  device: string;
  target: string;
  resolve: (ws: WebSocket) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/** `/reverse?stream=<id>` → the id, or null when this is not a callback socket. */
export function parseStreamId(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  const url = new URL(rawUrl, 'http://placeholder');
  if (url.pathname !== REVERSE_PATH_PREFIX) return null;
  const id = url.searchParams.get('stream');
  // Ids are minted here and echoed back verbatim; anything else is not ours.
  return id && /^[0-9a-f]{32}$/.test(id) ? id : null;
}

export interface StreamRequest {
  id: string;
  /** Message to hand to the device over its control socket. */
  message: { type: 'open-stream'; streamId: string; host: string; port: number };
  /** Resolves with the device's callback socket, or rejects on timeout. */
  socket: Promise<WebSocket>;
}

/**
 * Mint a stream the device is expected to dial back for. The caller sends `message` over the
 * device's control socket and then awaits `socket`.
 */
export function requestStream(device: string, host: string, port: number): StreamRequest {
  if (pending.size >= MAX_PENDING) {
    throw new Error(`too many pending reverse streams (${pending.size})`);
  }
  const id = crypto.randomBytes(16).toString('hex');
  const target = `${host}:${port}`;
  let resolve!: (ws: WebSocket) => void;
  let reject!: (err: Error) => void;
  const socket = new Promise<WebSocket>((res, rej) => { resolve = res; reject = rej; });
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`device ${device} did not open a stream to ${target} within ${CLAIM_TIMEOUT_MS}ms`));
  }, CLAIM_TIMEOUT_MS);
  timer.unref?.();
  pending.set(id, { device, target, resolve, reject, timer });
  return { id, message: { type: 'open-stream', streamId: id, host, port }, socket };
}

/**
 * Pair a callback socket with its request. Returns false when the id is unknown — a stale or forged
 * callback, which the caller closes rather than trusts.
 */
export function claimStream(id: string, ws: WebSocket): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  log.info(`stream ${id.slice(0, 8)} claimed by ${entry.device} → ${entry.target}`);
  entry.resolve(ws);
  return true;
}

/** Drop every pending request for a device that just went away, so nobody waits the full timeout. */
export function cancelStreamsFor(device: string): number {
  let cancelled = 0;
  for (const [id, entry] of pending) {
    if (entry.device !== device) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new Error(`device ${device} disconnected before opening the stream`));
    cancelled++;
  }
  return cancelled;
}

export function pendingStreamCount(): number {
  return pending.size;
}
