import { fileDownloadUrl } from '@/lib/files';
import { authHeaders } from '@/lib/desktop-config';

// A preview reads at most `limit` bytes of a workspace file. A declared Content-Length over the
// limit refuses the file before any body is read; without one the body is streamed and dropped the
// moment it passes the limit, so a multi-GB log is never pulled into the page just to be refused.

export type CappedBytes = { kind: 'ok'; bytes: Uint8Array } | { kind: 'toolarge' };

const TOO_LARGE: CappedBytes = { kind: 'toolarge' };

function declaredLength(res: Response): number | null {
  const raw = res.headers.get('content-length');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readCappedBody(res: Response, limit: number): Promise<CappedBytes> {
  const declared = declaredLength(res);
  if (declared !== null && declared > limit) {
    await res.body?.cancel().catch(() => {});
    return TOO_LARGE;
  }
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength > limit ? TOO_LARGE : { kind: 'ok', bytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { kind: 'ok', bytes: concat(chunks, total) };
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return TOO_LARGE;
    }
    chunks.push(value);
  }
}

/** Authenticated fetch of a workspace `path`, capped at `limit` bytes. `signal` cancels the request
 *  (the previewer aborts it when it closes or switches files). */
export async function fetchWorkspaceBytes(path: string, limit: number, signal?: AbortSignal): Promise<CappedBytes> {
  const res = await fetch(fileDownloadUrl(path, 'inline'), { headers: authHeaders(), signal });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`download failed: ${res.status}`);
  }
  return readCappedBody(res, limit);
}
