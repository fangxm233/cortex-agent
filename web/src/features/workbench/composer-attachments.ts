// input:  Composer files, upload scope, progress callbacks, and restored metadata
// output: Pending attachment model, accessors, upload transport, and restore helpers
// pos:    Desktop composer attachment state boundary
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { apiBase, authHeaders } from '@/lib/desktop-config';
import type { AttachmentMeta } from './chat-content';

const UPLOAD_PATH = '/api/attachments/upload';

export interface PendingAttachment {
  id: string;
  /** Restored draft attachments carry server metadata without local file bytes. */
  file?: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  meta?: AttachmentMeta;
  errorMsg?: string;
  /** Local object URL for image/video previews; revoked on remove or send. */
  previewUrl?: string;
}

export function attachmentMime(a: PendingAttachment): string {
  return a.file?.type ?? a.meta?.mimeType ?? '';
}

export function attachmentName(a: PendingAttachment): string {
  return a.file?.name ?? a.meta?.name ?? 'file';
}

export function attachmentSize(a: PendingAttachment): number {
  return a.file?.size ?? a.meta?.size ?? 0;
}

export function attachmentType(a: PendingAttachment): AttachmentMeta['type'] {
  const mime = attachmentMime(a);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

function uploadHeaders(file: File, sessionId: string): Record<string, string> {
  return {
    'X-Session-Id': sessionId,
    'X-File-Name': encodeURIComponent(file.name),
    'Content-Type': file.type || 'application/octet-stream',
    ...authHeaders(),
  };
}

function uploadFailure(xhr: XMLHttpRequest): Error {
  if (xhr.status === 413) return new Error('File too large');
  return new Error(`Upload failed (${xhr.status})`);
}

function readUploadResponse(xhr: XMLHttpRequest): AttachmentMeta {
  const body = xhr.response as { ok?: boolean; data?: AttachmentMeta; message?: string };
  if (body?.ok && body.data) return body.data;
  throw new Error(body?.message || `Upload failed (${xhr.status})`);
}

function bindUploadEvents(
  xhr: XMLHttpRequest,
  onProgress: (pct: number) => void,
  resolve: (meta: AttachmentMeta) => void,
  reject: (error: Error) => void,
): void {
  xhr.upload.addEventListener('progress', (event) => {
    if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
  });
  xhr.addEventListener('load', () => {
    if (xhr.status < 200 || xhr.status >= 300) return reject(uploadFailure(xhr));
    try { resolve(readUploadResponse(xhr)); } catch (error) { reject(error as Error); }
  });
  xhr.addEventListener('error', () => reject(new Error('Network error')));
  xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
}

export function uploadComposerFile(
  file: File,
  sessionId: string,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<AttachmentMeta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${apiBase()}${UPLOAD_PATH}`);
    Object.entries(uploadHeaders(file, sessionId)).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.responseType = 'json';
    signal.addEventListener('abort', () => xhr.abort());
    bindUploadEvents(xhr, onProgress, resolve, reject);
    xhr.send(file);
  });
}

let attachmentId = 0;
export function nextAttachmentId(): string {
  return `att_${++attachmentId}_${Date.now()}`;
}

export function completedAttachmentMetas(items: PendingAttachment[]): AttachmentMeta[] {
  return items.filter((item) => item.status === 'done' && item.meta).map((item) => item.meta!);
}

export function mergeRestoredAttachments(
  current: PendingAttachment[],
  sent: AttachmentMeta[],
): PendingAttachment[] {
  const paths = new Set(current.flatMap((item) => item.meta?.path ? [item.meta.path] : []));
  const restored = sent.filter((meta) => !paths.has(meta.path)).map((meta) => ({
    id: nextAttachmentId(), status: 'done' as const, progress: 100, meta,
  }));
  return [...restored, ...current];
}
