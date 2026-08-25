// input:  authenticated WebSocket upgrades, a port policy, and `ss` output
// output: a TCP-over-WebSocket forward plus the listening-port discovery route
// pos:    Web UI transport host — the tunnel-traversing half of the desktop port forward
// >>> If I am updated, update CORTEX.md <<<

import * as http from 'http';
import * as net from 'net';
import type { Duplex } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from '@core/log.js';

const log = createLogger('port-forward');
const execFileAsync = promisify(execFile);

/**
 * Why TCP-over-WebSocket instead of an HTTP reverse proxy (plan/embedded-browser.md §4):
 * forwarding at the TCP layer moves the whole ORIGIN to the client machine. Absolute paths,
 * cookies, storage and the HMR WebSocket all work untouched, and the previewed page can never be
 * same-origin with the app page or the API. WebSocket (rather than a bare `Upgrade:`) is required
 * because that is the only upgrade protocol the Cloudflare edge proxies.
 */

/** Upgrade path the desktop shell dials. */
export const FORWARD_PATH = '/forward';

/** Discovery route: which loopback ports are currently listening on this host. */
export const FORWARD_PORTS_PATH = '/api/forward/ports';

/** Privileged ports are never forwarded — nothing a dev server needs lives below 1024, and the
 *  accident (forwarding 22 or 3389) is worse than the inconvenience. */
const MIN_FORWARDABLE_PORT = 1024;

/** Bound so a leaking client cannot exhaust file descriptors. */
const MAX_CONCURRENT = 64;

/** Close codes the desktop shell distinguishes. 1000-2999 are reserved by the protocol. */
export const CLOSE_TARGET_UNREACHABLE = 4004;
export const CLOSE_POLICY = 4003;

export interface ForwardTarget {
  host: string;
  port: number;
}

/**
 * Parse `/forward?port=5173[&host=127.0.0.1]`.
 *
 * Only loopback hosts are accepted: this endpoint exists to reach services on the SERVER, and
 * accepting an arbitrary host would turn it into a general-purpose SSRF/relay. Reaching another
 * machine is the reverse channel's job, not this one's.
 */
export function parseForwardTarget(rawUrl: string): ForwardTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://localhost');
  } catch {
    return null;
  }
  const port = Number(url.searchParams.get('port'));
  if (!Number.isInteger(port) || port < MIN_FORWARDABLE_PORT || port > 65535) return null;
  const host = url.searchParams.get('host') ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null;
  return { host, port };
}

// ── Discovery ─────────────────────────────────────────────────────────────────

export interface ListeningPort {
  port: number;
  /** Bound address as reported by `ss` — 127.0.0.1, 0.0.0.0, *, [::], … */
  address: string;
  /** Best-effort process name, or null when `ss` could not attribute it (no permission). */
  process: string | null;
}

/**
 * Parse `ss -ltnH` (with or without `-p`) into listening ports reachable over loopback.
 *
 * Lines look like:
 *   LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1,fd=24))
 *   LISTEN 0 4096 *:3005 *:*
 * A port bound only to a non-loopback interface is dropped: the forward connects to 127.0.0.1,
 * so listing it would offer a target that cannot actually be reached.
 */
export function parseSsListeners(stdout: string): ListeningPort[] {
  const out = new Map<number, ListeningPort>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[3];
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port) || port < MIN_FORWARDABLE_PORT) continue;
    const address = local.slice(0, idx);
    const loopback = address === '127.0.0.1' || address === '[::1]' || address === '*' || address === '0.0.0.0' || address === '[::]';
    if (!loopback) continue;
    const proc = /users:\(\("([^"]+)"/.exec(line);
    const existing = out.get(port);
    // Prefer the entry that carries a process name.
    if (!existing || (!existing.process && proc)) {
      out.set(port, { port, address, process: proc ? proc[1] : null });
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

async function listListeningPorts(): Promise<ListeningPort[]> {
  try {
    const { stdout } = await execFileAsync('ss', ['-ltnpH'], { timeout: 3000 });
    return parseSsListeners(stdout);
  } catch {
    // `-p` needs no privileges for own-user sockets, but `ss` may be absent entirely.
    try {
      const { stdout } = await execFileAsync('ss', ['-ltnH'], { timeout: 3000 });
      return parseSsListeners(stdout);
    } catch (e) {
      log.warn(`port discovery unavailable: ${(e as Error).message}`);
      return [];
    }
  }
}

/** Discovery route, mounted through `customRoutes` so it inherits the same auth gate. */
export function createForwardRoutes(): Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>> {
  return {
    [FORWARD_PORTS_PATH]: async (_req, res) => {
      const ports = await listListeningPorts();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data: { ports } }));
    },
  };
}

// ── The forward itself ────────────────────────────────────────────────────────

export interface PortForwardHandle {
  /** Handles an already-authenticated upgrade for FORWARD_PATH. */
  handleUpgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
}

/**
 * One WebSocket carries one TCP connection — no multiplexing. The desktop shell opens a fresh
 * socket per browser connection anyway, and a multiplexed channel would have to re-invent flow
 * control per stream. Backpressure comes free: the TCP side is paused until each frame is flushed.
 */
export function createPortForward(): PortForwardHandle {
  const wss = new WebSocketServer({ noServer: true });
  let open = 0;

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const target = parseForwardTarget(req.url ?? '');
    if (!target) {
      socket.destroy();
      return;
    }
    if (open >= MAX_CONCURRENT) {
      log.warn(`forward refused (${open} already open): ${target.host}:${target.port}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      open += 1;
      pipe(ws, target, () => {
        open -= 1;
      });
    });
  };

  return { handleUpgrade, close: () => wss.close() };
}

function pipe(ws: WebSocket, target: ForwardTarget, done: () => void): void {
  const tcp = net.connect({ host: target.host, port: target.port });
  tcp.setNoDelay(true);
  let finished = false;

  const finish = (code: number, reason: string): void => {
    if (finished) return;
    finished = true;
    tcp.destroy();
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
    done();
  };

  tcp.on('connect', () => {
    log.info(`forward open → ${target.host}:${target.port}`);
  });

  // The dev server is not up yet (or died): tell the shell precisely, so it can show
  // "waiting for target" instead of a blank frame.
  tcp.on('error', (e) => finish(CLOSE_TARGET_UNREACHABLE, (e as NodeJS.ErrnoException).code ?? 'error'));
  tcp.on('close', () => finish(1000, 'target closed'));

  tcp.on('data', (chunk: Buffer) => {
    tcp.pause();
    ws.send(chunk, { binary: true }, () => tcp.resume());
  });

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    tcp.write(buf);
  });
  ws.on('close', () => finish(1000, 'client closed'));
  ws.on('error', () => finish(1011, 'socket error'));
}
