// input:  File bytes, attachment bucket, auth config, progress callback, and abort signal
// output: Authenticated XHR upload resolving canonical attachment metadata
// pos:    Shared desktop/mobile attachment upload transport
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { apiBase, authHeaders } from '@/lib/desktop-config';
import type { AttachmentMeta } from './types';

const UPLOAD_PATH = '/api/attachments/upload';

function uploadHeaders(file: File, bucket: string): Record<string, string> {
  return {
    'X-Session-Id': bucket,
    'X-File-Name': encodeURIComponent(file.name),
    'Content-Type': file.type || 'application/octet-stream',
    ...authHeaders(),
  };
}

function uploadFailure(xhr: XMLHttpRequest): Error {
  if (xhr.status === 413) return new Error('File too large');
  const body = xhr.response as { message?: string } | null;
  return new Error(body?.message || `Upload failed (${xhr.status})`);
}

function readUploadResponse(xhr: XMLHttpRequest): AttachmentMeta {
  const body = xhr.response as { ok?: boolean; data?: AttachmentMeta; message?: string } | null;
  if (body?.ok && body.data) return body.data;
  throw new Error(body?.message || `Upload failed (${xhr.status})`);
}

function bindProgress(xhr: XMLHttpRequest, onProgress: (pct: number) => void): void {
  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable || event.total <= 0) return;
    onProgress(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))));
  });
}

function sendUpload(
  xhr: XMLHttpRequest,
  file: File,
  onProgress: (pct: number) => void,
  settle: (error?: Error, meta?: AttachmentMeta) => void,
): void {
  bindProgress(xhr, onProgress);
  xhr.addEventListener('load', () => {
    if (xhr.status < 200 || xhr.status >= 300) return settle(uploadFailure(xhr));
    try { settle(undefined, readUploadResponse(xhr)); } catch (error) { settle(error as Error); }
  });
  xhr.addEventListener('error', () => settle(new Error('Network error')));
  xhr.addEventListener('abort', () => settle(new Error('Upload cancelled')));
  xhr.send(file);
}

export function uploadAttachment(
  file: File,
  bucket: string,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<AttachmentMeta> {
  if (signal.aborted) return Promise.reject(new Error('Upload cancelled'));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const settle = (error?: Error, meta?: AttachmentMeta): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(meta!);
    };
    const abort = (): void => xhr.abort();
    xhr.open('POST', `${apiBase()}${UPLOAD_PATH}`);
    Object.entries(uploadHeaders(file, bucket)).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.responseType = 'json';
    signal.addEventListener('abort', abort, { once: true });
    sendUpload(xhr, file, onProgress, settle);
  });
}

export type AttachmentUploadTransport = typeof uploadAttachment;
