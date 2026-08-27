// input:  Local files, restored upload metadata, and attachment queue state
// output: Neutral attachment facts, accessors, completed metadata, and send gating
// pos:    Shared desktop/mobile attachment domain model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export interface AttachmentMeta {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  type: 'image' | 'video' | 'file' | 'view';
}

export type AttachmentUploadStatus = 'queued' | 'uploading' | 'done' | 'error';

export interface AttachmentUploadItem {
  id: string;
  file?: File;
  status: AttachmentUploadStatus;
  progress: number;
  meta?: AttachmentMeta;
  errorMsg?: string;
  previewUrl?: string;
}

export function attachmentMime(item: AttachmentUploadItem): string {
  return item.file?.type ?? item.meta?.mimeType ?? '';
}

export function attachmentName(item: AttachmentUploadItem): string {
  return item.file?.name ?? item.meta?.name ?? 'file';
}

export function attachmentSize(item: AttachmentUploadItem): number {
  return item.file?.size ?? item.meta?.size ?? 0;
}

export function attachmentType(item: AttachmentUploadItem): AttachmentMeta['type'] {
  const mime = attachmentMime(item);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

export function completedAttachmentMetas(items: AttachmentUploadItem[]): AttachmentMeta[] {
  return items.flatMap((item) => item.status === 'done' && item.meta ? [item.meta] : []);
}

export function attachmentSendAllowed(text: string, items: AttachmentUploadItem[]): boolean {
  const allDone = items.every((item) => item.status === 'done');
  return allDone && (text.trim().length > 0 || items.some((item) => item.status === 'done'));
}
