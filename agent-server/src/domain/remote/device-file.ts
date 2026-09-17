import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { WebSocket } from 'ws';
import { WORKSPACE_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { sendCommand, sendControlMessage, getOnlineDevices } from './client-manager.js';
import { requestFileStream } from './reverse-stream.js';

const log = createLogger('device-file');

/**
 * Pull a whole file off a device (`send_file device=…`). Every other remote tool answers on the
 * control socket as one JSON message, which is fine for text but not for bytes: a file would be
 * base64'd whole into memory on both ends and would hold the device's single command channel for
 * the length of the transfer. So this uses the reverse channel instead — the same handshake the
 * port forward already relies on — and streams binary frames straight to disk.
 *
 * The transfer is two steps on purpose. `file.stat` first, over the ordinary command path, so a
 * missing path or an over-cap file fails with a real error message; only then is the stream opened.
 * The stat'd size then doubles as the completeness check: a transfer that ends early is rejected
 * rather than silently delivering a truncated file.
 */

/** The device must have dialled back AND finished within this; a stalled transfer is not a hang. */
const IDLE_TIMEOUT_MS = 60_000;

/** `file.stat` is a metadata round trip — the client-manager file-command timeout is plenty. */
export interface RemoteFileStat {
  size: number;
  name: string;
  mtimeMs?: number;
}

/** Capability advertised in the device's `hello`. Absent on clients older than this feature. */
const FILE_STREAM_CAPABILITY = 'file-stream';

function assertCanStreamFiles(device: string): void {
  const info = getOnlineDevices().find(d => d.device === device);
  if (!info) throw new Error(`Device "${device}" is not online`);
  if (!info.capabilities?.includes(FILE_STREAM_CAPABILITY)) {
    throw new Error(
      `Device "${device}" runs a client too old to stream files. It updates itself on its next `
      + 'reconnect; until then, copy the file to the server yourself.',
    );
  }
}

/** Metadata probe: existence, regular-file-ness and size, with the device's own error text. */
export async function statRemoteFile(device: string, filePath: string): Promise<RemoteFileStat> {
  const data = await sendCommand(device, { action: 'file.stat', params: { file_path: filePath } });
  if (typeof data?.size !== 'number') throw new Error(`Device "${device}" returned no size for ${filePath}`);
  return { size: data.size, name: data.name || filePath.split(/[/\\]/).pop() || 'file', mtimeMs: data.mtimeMs };
}

/** Receive the callback socket's frames into `destPath`, resolving with the byte count. */
function receiveInto(ws: WebSocket, destPath: string, expected: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    let received = 0;
    let settled = false;
    let idle: NodeJS.Timeout;

    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      // End the file either way: the caller deletes a failed destination, and leaving the handle
      // open would keep it undeletable on Windows.
      out.end(() => (err ? reject(err) : resolve(received)));
      if (err) { try { ws.close(); } catch { /* already closing */ } }
    };

    const armIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(
        () => finish(new Error(`transfer stalled after ${received}/${expected} bytes`)),
        IDLE_TIMEOUT_MS,
      );
      idle.unref?.();
    };
    armIdle();

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      received += buf.length;
      armIdle();
      if (received > expected) {
        finish(new Error(`device sent more than the ${expected} bytes it declared`));
        return;
      }
      // Pause the socket while the disk catches up, so a slow filesystem costs time, not memory.
      if (!out.write(buf)) {
        (ws as unknown as { pause?: () => void }).pause?.();
        out.once('drain', () => (ws as unknown as { resume?: () => void }).resume?.());
      }
    });

    ws.on('error', (e: Error) => finish(new Error(`stream error: ${e.message}`)));
    out.on('error', (e: Error) => finish(new Error(`write failed: ${e.message}`)));

    ws.on('close', (code: number, reason: Buffer) => {
      const why = reason?.toString() || '';
      // The client reports a read-side failure by closing with a reason instead of by sending
      // fewer bytes, so an explicit error is never mistaken for a short file and vice versa.
      if (code !== 1000) { finish(new Error(why || `device closed the stream (code ${code})`)); return; }
      if (received !== expected) {
        finish(new Error(`truncated transfer: got ${received} of ${expected} bytes${why ? ` (${why})` : ''}`));
        return;
      }
      finish(null);
    });
  });
}

/**
 * Everything that can be known — and refused — before a single byte moves: that the device is
 * online and new enough, that the path is a readable file, and that it fits under the cap. Callers
 * that need the file's NAME to choose a destination run this first and hand the result back to
 * `fetchRemoteFile`, so the device is stat'ed once rather than twice.
 */
export async function prepareRemoteFetch(a: {
  device: string; filePath: string; maxBytes?: number;
}): Promise<RemoteFileStat> {
  assertCanStreamFiles(a.device);
  const stat = await statRemoteFile(a.device, a.filePath);
  if (a.maxBytes !== undefined && stat.size > a.maxBytes) {
    throw new Error(`File is ${stat.size} bytes on ${a.device}, over the ${a.maxBytes}-byte limit`);
  }
  return stat;
}

export interface FetchRemoteFileArgs {
  device: string;
  /** Absolute path ON THE DEVICE. */
  filePath: string;
  /** Local destination; its directory must already exist. */
  destPath: string;
  /** Refuse before transferring anything when the device reports a larger file. */
  maxBytes?: number;
  /** Result of an earlier `prepareRemoteFetch` for this exact file; skips the second stat. */
  stat?: RemoteFileStat;
}

/**
 * Copy `filePath` from `device` into `destPath`. Throws — leaving no partial file behind — when the
 * device is offline, too old, the path is not a readable file, it exceeds `maxBytes`, or the
 * transfer ends short.
 */
export async function fetchRemoteFile(a: FetchRemoteFileArgs): Promise<RemoteFileStat> {
  const stat = a.stat ?? await prepareRemoteFetch(a);

  const req = requestFileStream(a.device, a.filePath);
  // The claim rejects on its own timer (or when the device disconnects) whether or not anyone is
  // waiting — and if `sendControlMessage` throws we never reach the await. An unobserved rejection
  // would take the daemon down, so mark it handled now; the await below still sees the real error.
  req.socket.catch(() => {});

  let ws: WebSocket;
  try {
    sendControlMessage(a.device, req.message);
    ws = await req.socket;
  } catch (e) {
    throw new Error(`Failed to open a file stream from "${a.device}": ${(e as Error).message}`);
  }

  try {
    const received = await receiveInto(ws, a.destPath, stat.size);
    log.info(`fetched ${a.filePath} from ${a.device} (${received} bytes)`);
    return stat;
  } catch (e) {
    await fs.promises.rm(a.destPath, { force: true }).catch(() => {});
    throw new Error(`Transfer of ${a.filePath} from "${a.device}" failed: ${(e as Error).message}`);
  }
}

// --- Staging for senders that upload from a local path ---

/** Transfers in flight for a platform upload live here, one directory per transfer so two files of
 *  the same name never collide. */
const STAGING_DIR = path.join(WORKSPACE_DIR, 'remote-files');

/** A staged file outlives its upload only if that upload crashed; an hour is far past any transfer
 *  still worth waiting for. */
const STAGING_TTL_MS = 60 * 60_000;

/** Opportunistic sweep so a crashed uploader leaks at most one TTL window rather than forever. */
async function sweepStaging(): Promise<void> {
  const cutoff = Date.now() - STAGING_TTL_MS;
  let entries: string[];
  try { entries = await fs.promises.readdir(STAGING_DIR); } catch { return; }
  await Promise.all(entries.map(async name => {
    const dir = path.join(STAGING_DIR, name);
    try {
      const st = await fs.promises.stat(dir);
      if (st.mtimeMs < cutoff) await fs.promises.rm(dir, { recursive: true, force: true });
    } catch { /* raced with another sweep or an active uploader */ }
  }));
}

export interface StagedRemoteFile {
  /** Server-local path the caller reads, and is expected to delete when done. */
  localPath: string;
  name: string;
  size: number;
}

/**
 * Stream a device's file into a server-local staging path. Used by senders that do their own upload
 * from disk (Slack, Feishu); the Web sender writes into the session's outputs directly instead.
 */
export async function stageRemoteFile(a: {
  device: string; filePath: string; maxBytes?: number;
}): Promise<StagedRemoteFile> {
  const stat = await prepareRemoteFetch(a);
  void sweepStaging();

  const dir = path.join(STAGING_DIR, crypto.randomBytes(8).toString('hex'));
  await fs.promises.mkdir(dir, { recursive: true });
  // The device's own basename, with separators stripped: it is remote input, and it must not be
  // able to steer the write out of the staging directory.
  const safeName = (stat.name.replace(/[/\\]/g, '_') || 'file').slice(0, 200);
  const localPath = path.join(dir, safeName);

  try {
    await fetchRemoteFile({ device: a.device, filePath: a.filePath, destPath: localPath, stat });
  } catch (e) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return { localPath, name: safeName, size: stat.size };
}
