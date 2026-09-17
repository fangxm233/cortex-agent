import * as fs from 'fs';
import WebSocket from 'ws';
import { callbackUrl } from './reverse-stream.js';
import { createLogger } from './log.js';

const log = createLogger('file-stream');

/**
 * Sending a file the OTHER way: the server wants the bytes of a file that lives on THIS device
 * (`send_file device=…`). It reuses the reverse channel the port forward already proved — the
 * server asks over the control socket, we dial a new outbound WebSocket back and push the file
 * into it as binary frames.
 *
 * Why not answer on the control socket like every other command: a command result is one JSON
 * message, so a file would have to be base64'd whole into memory on both ends and would block
 * every other command for the device while it is in flight. A dedicated socket streams, costs no
 * base64, and a failure takes down only that transfer.
 *
 * The server always validates the path with a `file.stat` command FIRST, so by the time this runs
 * the file is known to exist and to be within the size cap. Anything that still goes wrong is
 * reported by closing the socket with a 4010 code and the reason text — never by a partial file
 * that looks complete, because the server also checks the byte count against the stat'd size.
 */
export interface OpenFileStreamMessage {
  type: 'open-file-stream';
  streamId: string;
  path: string;
}

export function isOpenFileStream(msg: unknown): msg is OpenFileStreamMessage {
  const m = msg as OpenFileStreamMessage;
  return !!m && m.type === 'open-file-stream'
    && typeof m.streamId === 'string'
    && typeof m.path === 'string';
}

/** Close code carrying a read-side failure; the reason text is the message the server surfaces. */
export const FILE_STREAM_ERROR_CODE = 4010;

export interface FileStreamDeps {
  controlUrl: string;
  headers?: Record<string, string>;
  /** Applied to the requested path (Windows drive-letter rewriting on the client). */
  normalizePath?: (p: string) => string;
  connectWs?: (url: string, headers?: Record<string, string>) => WebSocket;
  openRead?: (filePath: string) => fs.ReadStream;
}

/**
 * Serve one open-file-stream request. Like `openReverseStream`, every failure is contained: the
 * sockets are closed and the control connection — which carries the whole device — is untouched.
 */
export function openFileStream(msg: OpenFileStreamMessage, deps: FileStreamDeps): void {
  const normalize = deps.normalizePath ?? ((p: string) => p);
  const connectWs = deps.connectWs ?? ((url, headers) => new WebSocket(url, headers ? { headers } : undefined));
  const openRead = deps.openRead ?? ((p: string) => fs.createReadStream(p));

  const filePath = normalize(msg.path);
  const short = msg.streamId.slice(0, 8);
  const ws = connectWs(callbackUrl(deps.controlUrl, msg.streamId), deps.headers);

  let file: fs.ReadStream | null = null;
  let closed = false;
  let sent = 0;

  const shutdown = (code: number, why: string): void => {
    if (closed) return;
    closed = true;
    log.info(`file stream ${short} closed after ${sent} bytes: ${why}`);
    try { ws.close(code, why.slice(0, 120)); } catch { /* already closing */ }
    try { file?.destroy(); } catch { /* already destroyed */ }
  };

  ws.on('open', () => {
    log.info(`file stream ${short} → ${filePath}`);
    let stream: fs.ReadStream;
    try {
      stream = openRead(filePath);
    } catch (e) {
      shutdown(FILE_STREAM_ERROR_CODE, `open failed: ${(e as Error).message}`);
      return;
    }
    file = stream;

    stream.on('data', (chunk: string | Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) {
        shutdown(FILE_STREAM_ERROR_CODE, 'socket closed mid-transfer');
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Read one chunk at a time: without this the whole file buffers in memory whenever the
      // socket is slower than the disk, which is the normal case over a tunnel.
      stream.pause();
      sent += buf.length;
      ws.send(buf, (err?: Error) => {
        if (err) shutdown(FILE_STREAM_ERROR_CODE, `send failed: ${err.message}`);
        else stream.resume();
      });
    });
    // A normal close (1000) with the expected byte count is the ONLY success signal the server
    // accepts, so EOF must never look like an error and an error must never look like EOF.
    stream.on('end', () => shutdown(1000, 'eof'));
    stream.on('error', (e: Error) => shutdown(FILE_STREAM_ERROR_CODE, `read failed: ${e.message}`));
  });

  ws.on('error', (e: Error) => shutdown(FILE_STREAM_ERROR_CODE, `ws error: ${e.message}`));
  ws.on('close', () => shutdown(1000, 'ws closed'));
}
