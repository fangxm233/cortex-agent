// input:  Mobile composer files, upload scope, persisted draft, and preview state
// output: Attachment upload transport, draft effects, and pending-item helpers
// pos:    Mobile chat attachment state boundary
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AttachmentMeta } from '@/features/workbench/chat-content';
import { loadDraft, saveDraft } from '@/features/workbench/composer-draft';
import { apiBase, authHeaders } from '@/lib/desktop-config';
import { fetchFileObjectUrl } from '@/lib/files';

const UPLOAD_PATH = '/api/attachments/upload';

export interface PendingUpload {
  id: string;
  file?: File;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  meta?: AttachmentMeta;
  type: 'image' | 'video' | 'file';
  previewUrl?: string;
}

export type SetPendingUploads = Dispatch<SetStateAction<PendingUpload[]>>;

export function mobileAttachmentChipType(type: AttachmentMeta['type']): 'image' | 'video' | 'file' {
  return type === 'image' || type === 'video' ? type : 'file';
}

function classifyFileType(file: File): 'image' | 'video' | 'file' {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'file';
}

let uid = 0;
export function nextMobileAttachmentId(): string {
  return `att_${++uid}_${Date.now()}`;
}

function uploadHeaders(file: File, sessionId: string): Record<string, string> {
  return {
    'X-Session-Id': sessionId,
    'X-File-Name': encodeURIComponent(file.name),
    'Content-Type': file.type || 'application/octet-stream',
    ...authHeaders(),
  };
}

function readUploadResponse(xhr: XMLHttpRequest): AttachmentMeta {
  const body = xhr.response as { ok?: boolean; data?: AttachmentMeta; message?: string } | null;
  if (xhr.status >= 200 && xhr.status < 300 && body?.ok && body.data) return body.data;
  throw new Error(body?.message || `Upload failed (${xhr.status})`);
}

export function uploadMobileChatFile(file: File, sessionId: string, onProgress: (pct: number) => void): Promise<AttachmentMeta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${apiBase()}${UPLOAD_PATH}`);
    Object.entries(uploadHeaders(file, sessionId)).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('load', () => { try { resolve(readUploadResponse(xhr)); } catch (error) { reject(error); } });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.send(file);
  });
}

function restoredUploads(attachments: AttachmentMeta[]): PendingUpload[] {
  return attachments.map((meta) => ({
    id: nextMobileAttachmentId(), status: 'done', progress: 100, meta,
    type: mobileAttachmentChipType(meta.type),
  }));
}

export function revokeUploadPreviews(uploads: PendingUpload[]): void {
  uploads.forEach((upload) => { if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl); });
}

interface DraftEffectParams {
  draftKey: string | null;
  isDraft: boolean;
  text: string;
  uploads: PendingUpload[];
  setText: (text: string) => void;
  setUploads: SetPendingUploads;
  draftUploadId: MutableRefObject<string | null>;
  draftKeyRef: MutableRefObject<string | null | undefined>;
}

function loadChangedDraft(params: DraftEffectParams): boolean {
  if (params.draftKeyRef.current === params.draftKey) return false;
  params.draftKeyRef.current = params.draftKey;
  if (!params.draftKey) return true;
  const draft = loadDraft(params.draftKey);
  if (params.isDraft && draft?.draftUploadId) params.draftUploadId.current = draft.draftUploadId;
  params.setText(draft?.text ?? '');
  params.setUploads((previous) => {
    revokeUploadPreviews(previous);
    return restoredUploads(draft?.attachments ?? []);
  });
  return true;
}

function saveCurrentDraft(params: DraftEffectParams): void {
  saveDraft(params.draftKey, {
    text: params.text,
    attachments: params.uploads.filter((upload) => upload.status === 'done' && upload.meta).map((upload) => upload.meta!),
    ...(params.isDraft && params.draftUploadId.current ? { draftUploadId: params.draftUploadId.current } : {}),
  });
}

export function usePersistedMobileChatDraft(params: DraftEffectParams): void {
  useEffect(() => {
    if (loadChangedDraft(params)) return;
    saveCurrentDraft(params);
    // Params intentionally mirror the former in-screen effect's content dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.draftKey, params.text, params.uploads, params.isDraft]);
}

function needsRemotePreview(upload: PendingUpload): boolean {
  return !upload.file && !upload.previewUrl && upload.status === 'done' && !!upload.meta
    && (upload.type === 'image' || upload.type === 'video');
}

export function useRestoredMobileAttachmentPreviews(uploads: PendingUpload[], setUploads: SetPendingUploads): void {
  useEffect(() => {
    let cancelled = false;
    uploads.filter(needsRemotePreview).forEach((upload) => {
      fetchFileObjectUrl(upload.meta!.path, 'inline').then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        setUploads((previous) => previous.map((item) => item.id === upload.id ? { ...item, previewUrl: url } : item));
      }).catch(() => { /* preview is best-effort */ });
    });
    return () => { cancelled = true; };
  }, [uploads, setUploads]);
}

function beginUpload(file: File, sessionId: string, setUploads: SetPendingUploads): void {
  const id = nextMobileAttachmentId();
  const type = classifyFileType(file);
  const previewUrl = type === 'image' || type === 'video' ? URL.createObjectURL(file) : undefined;
  setUploads((previous) => [...previous, { id, file, status: 'uploading', progress: 0, type, previewUrl }]);
  uploadMobileChatFile(file, sessionId, (progress) => {
    setUploads((previous) => previous.map((upload) => upload.id === id ? { ...upload, progress } : upload));
  }).then((meta) => {
    setUploads((previous) => previous.map((upload) => upload.id === id ? { ...upload, status: 'done', progress: 100, meta } : upload));
  }).catch(() => {
    setUploads((previous) => previous.map((upload) => upload.id === id ? { ...upload, status: 'error' } : upload));
  });
}

export function addMobileChatFiles(files: FileList | File[], sessionId: string, setUploads: SetPendingUploads): void {
  Array.from(files).forEach((file) => beginUpload(file, sessionId, setUploads));
}
