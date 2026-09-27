import type { Lang } from '@/i18n';
import { apiBase, authHeaders } from '@/lib/desktop-config';
import type { AttachmentMeta } from './types';

const UPLOAD_PATH = '/api/attachments/upload';

type UploadErrorCode = 'too-large' | 'failed' | 'network' | 'cancelled';

const UPLOAD_ERROR_COPY: Record<Lang, Record<UploadErrorCode, string>> = {
  en: { 'too-large': 'File too large', failed: 'Upload failed', network: 'Network error', cancelled: 'Upload cancelled' },
  zh: { 'too-large': '文件太大', failed: '上传失败', network: '网络错误', cancelled: '已取消上传' },
};

/** A failure this module words itself; `uploadErrorText` localizes it. Server messages stay plain Errors. */
export class AttachmentUploadError extends Error {
  constructor(readonly code: UploadErrorCode, readonly status?: number) {
    super(uploadErrorWording(code, 'en', status));
  }
}

function uploadErrorWording(code: UploadErrorCode, lang: Lang, status?: number): string {
  const text = UPLOAD_ERROR_COPY[lang][code];
  return status === undefined ? text : `${text} (${status})`;
}

/** The chip's error line in the UI language; raw server detail passes through unchanged. */
export function uploadErrorText(error: unknown, lang: Lang): string {
  if (error instanceof AttachmentUploadError) return uploadErrorWording(error.code, lang, error.status);
  return error instanceof Error ? error.message : uploadErrorWording('failed', lang);
}

function uploadHeaders(file: File, bucket: string): Record<string, string> {
  return {
    'X-Session-Id': bucket,
    'X-File-Name': encodeURIComponent(file.name),
    'Content-Type': file.type || 'application/octet-stream',
    ...authHeaders(),
  };
}

function uploadFailure(xhr: XMLHttpRequest): Error {
  if (xhr.status === 413) return new AttachmentUploadError('too-large');
  const body = xhr.response as { message?: string } | null;
  return body?.message ? new Error(body.message) : new AttachmentUploadError('failed', xhr.status);
}

function readUploadResponse(xhr: XMLHttpRequest): AttachmentMeta {
  const body = xhr.response as { ok?: boolean; data?: AttachmentMeta; message?: string } | null;
  if (body?.ok && body.data) return body.data;
  throw body?.message ? new Error(body.message) : new AttachmentUploadError('failed', xhr.status);
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
  xhr.addEventListener('error', () => settle(new AttachmentUploadError('network')));
  xhr.addEventListener('abort', () => settle(new AttachmentUploadError('cancelled')));
  xhr.send(file);
}

export function uploadAttachment(
  file: File,
  bucket: string,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<AttachmentMeta> {
  if (signal.aborted) return Promise.reject(new AttachmentUploadError('cancelled'));
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
