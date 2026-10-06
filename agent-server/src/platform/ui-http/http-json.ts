// JSON request/response helpers shared by the ui-http custom routes.
//
// Every custom route answers in one shape: `{ ok: true, data }` on success and
// `{ ok: false, code, message }` on failure — `code` is a stable machine-readable string the web
// client may switch on, `message` is English detail for logs and as a last-resort display.

import type * as http from 'http';

/** Largest request body a custom route reads. Every route's body is a couple of short fields. */
const MAX_BODY_BYTES = 8192;

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: http.OutgoingHttpHeaders = {},
): void {
  if (res.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    ...headers,
  });
  res.end(payload);
}

export function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: http.OutgoingHttpHeaders = {},
): void {
  sendJson(res, status, { ok: false, code, message }, headers);
}

/**
 * JSON for the update manifests. They must never be cached by an intermediary (Cloudflare/proxy):
 * a stale manifest would advertise the wrong version (or bundle sha) to the client.
 */
export function sendNoStoreJson(res: http.ServerResponse, status: number, body: unknown): void {
  sendJson(res, status, body, { 'Cache-Control': 'no-store' });
}

/** The 405 every method-restricted route answers with. */
export function sendMethodNotAllowed(res: http.ServerResponse, allow: string): void {
  sendError(res, 405, 'method-not-allowed', `Use ${allow}`, { Allow: allow });
}

/** Declared `Content-Length`, or null when absent/unparseable (chunked). */
export function declaredLength(req: http.IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Answer an oversized request while keeping the connection readable. Destroying the socket with
 * request bytes still in flight makes the peer's kernel reset the connection, and a browser then
 * reports a network error instead of the status — so the rest of the body is read and thrown away.
 * Past `drainCap` further bytes the client is no longer worth waiting for and the socket is closed.
 */
export function rejectAndDrain(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  drainCap: number,
): void {
  let drained = 0;
  req.on('data', (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > drainCap) req.socket.destroy();
  });
  req.on('error', () => { /* the client went away; nothing left to answer */ });
  req.resume();
  sendError(res, status, code, message);
}

/**
 * Read a small JSON object body. Answers 413 (too large) or 400 (malformed, or valid JSON that is
 * not an object, such as `null`) itself and returns null; the caller just returns.
 */
export async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  const tooLarge = (): null => {
    rejectAndDrain(req, res, 413, 'too-large', `Body exceeds ${MAX_BODY_BYTES} bytes`, MAX_BODY_BYTES);
    return null;
  };
  if ((declaredLength(req) ?? 0) > MAX_BODY_BYTES) return tooLarge();

  const body = await new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) { chunks.push(chunk); return; }
      cleanup();
      resolve(null);
    };
    const onEnd = (): void => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
  if (body === null) return tooLarge();
  if (body.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendError(res, 400, 'bad-json', 'Body is not valid JSON');
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendError(res, 400, 'bad-json', 'Body must be a JSON object');
    return null;
  }
  return parsed as Record<string, unknown>;
}
