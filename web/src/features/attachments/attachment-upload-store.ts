// input:  Attachment binding, local files, restored metadata, transport, and preview loader
// output: Observable three-lane FIFO upload state with abort-safe lifecycle operations
// pos:    Framework-light engine behind the shared attachment upload hook
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { fetchFileObjectUrl } from '@/lib/files';
import { uploadAttachment, type AttachmentUploadTransport } from './upload-attachment';
import type { AttachmentMeta, AttachmentUploadItem } from './types';

const DEFAULT_CONCURRENCY = 3;
let nextId = 0;

function attachmentId(): string {
  nextId += 1;
  return `att_${nextId}_${Date.now()}`;
}

function previewable(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('video/');
}

function localItem(file: File): AttachmentUploadItem {
  return {
    id: attachmentId(), file, status: 'queued', progress: 0,
    previewUrl: previewable(file.type) ? URL.createObjectURL(file) : undefined,
  };
}

function restoredItem(meta: AttachmentMeta): AttachmentUploadItem {
  return { id: attachmentId(), status: 'done', progress: 100, meta };
}

function defaultPreview(path: string): Promise<string> {
  return fetchFileObjectUrl(path, 'inline');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Upload failed';
}

function needsPreview(item: AttachmentUploadItem): boolean {
  return !item.file && !item.previewUrl && item.status === 'done' && !!item.meta
    && previewable(item.meta.mimeType);
}

export interface AttachmentStoreOptions {
  scope: string | null;
  bucket: string;
  concurrency?: number;
  transport?: AttachmentUploadTransport;
  fetchPreview?: (path: string) => Promise<string>;
}

type Listener = () => void;

export class AttachmentUploadStore {
  private items: AttachmentUploadItem[] = [];
  private listeners = new Set<Listener>();
  private controllers = new Map<string, AbortController>();
  private requestedPreviews = new Set<string>();
  private revoked = new Set<string>();
  private generation = 0;
  private disposalVersion = 0;
  private options: Required<Pick<AttachmentStoreOptions, 'scope' | 'bucket' | 'concurrency' | 'transport' | 'fetchPreview'>>;

  constructor(options: AttachmentStoreOptions) {
    this.options = this.normalized(options);
  }

  private normalized(options: AttachmentStoreOptions): typeof this.options {
    return {
      scope: options.scope,
      bucket: options.bucket,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      transport: options.transport ?? uploadAttachment,
      fetchPreview: options.fetchPreview ?? defaultPreview,
    };
  }

  getSnapshot = (): AttachmentUploadItem[] => this.items;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  bind(options: AttachmentStoreOptions): void {
    const next = this.normalized(options);
    const changed = next.scope !== this.options.scope || next.bucket !== this.options.bucket;
    this.options = next;
    if (changed) this.reset();
  }

  private publish(next: AttachmentUploadItem[]): void {
    this.items = next;
    this.listeners.forEach((listener) => listener());
  }

  private revoke(url?: string): void {
    if (!url || this.revoked.has(url)) return;
    this.revoked.add(url);
    URL.revokeObjectURL(url);
  }

  private abortAll(): void {
    const active = [...this.controllers.values()];
    this.controllers.clear();
    active.forEach((controller) => controller.abort());
  }

  reset = (): void => {
    this.generation += 1;
    this.abortAll();
    this.requestedPreviews.clear();
    this.items.forEach((item) => this.revoke(item.previewUrl));
    this.publish([]);
  };

  cancelDisposal(): void {
    this.disposalVersion += 1;
  }

  scheduleDisposal(): void {
    const version = ++this.disposalVersion;
    queueMicrotask(() => {
      if (this.disposalVersion === version) this.reset();
    });
  }

  addFiles = (files: FileList | File[]): void => {
    const added = Array.from(files).map(localItem);
    if (added.length === 0) return;
    this.publish([...this.items, ...added]);
    this.pump();
  };

  remove = (id: string): void => {
    const item = this.items.find((entry) => entry.id === id);
    const controller = this.controllers.get(id);
    this.controllers.delete(id);
    controller?.abort();
    this.requestedPreviews.delete(id);
    this.revoke(item?.previewUrl);
    this.publish(this.items.filter((entry) => entry.id !== id));
    this.pump();
  };

  retry = (id: string): void => {
    const item = this.items.find((entry) => entry.id === id && entry.status === 'error');
    if (!item?.file) return;
    const queued: AttachmentUploadItem = { ...item, status: 'queued', progress: 0, errorMsg: undefined };
    this.publish([...this.items.filter((entry) => entry.id !== id), queued]);
    this.pump();
  };

  replaceRestored = (metas: AttachmentMeta[]): void => {
    this.generation += 1;
    this.abortAll();
    this.requestedPreviews.clear();
    this.items.forEach((item) => this.revoke(item.previewUrl));
    this.publish(metas.map(restoredItem));
  };

  mergeRestored = (metas: AttachmentMeta[]): void => {
    const paths = new Set(this.items.flatMap((item) => item.meta?.path ? [item.meta.path] : []));
    const restored = metas.filter((meta) => !paths.has(meta.path)).map(restoredItem);
    if (restored.length > 0) this.publish([...restored, ...this.items]);
  };

  private pump(): void {
    const slots = Math.max(0, this.options.concurrency - this.controllers.size);
    this.items.filter((item) => item.status === 'queued').slice(0, slots).forEach((item) => this.launch(item));
  }

  private launch(item: AttachmentUploadItem): void {
    if (!item.file || this.controllers.has(item.id)) return;
    const controller = new AbortController();
    const attempt = this.generation;
    this.controllers.set(item.id, controller);
    this.publish(this.items.map((entry) => entry.id === item.id
      ? { ...entry, status: 'uploading', progress: 0, errorMsg: undefined } : entry));
    void this.options.transport(item.file, this.options.bucket, (value) => {
      this.progress(item.id, attempt, value);
    }, controller.signal).then((meta) => {
      this.finish(item.id, attempt, meta);
    }).catch((error) => this.finish(item.id, attempt, undefined, error));
  }

  private progress(id: string, attempt: number, value: number): void {
    if (this.generation !== attempt || !this.controllers.has(id)) return;
    this.publish(this.items.map((item) => item.id === id ? { ...item, progress: value } : item));
  }

  private finish(id: string, attempt: number, meta?: AttachmentMeta, error?: unknown): void {
    if (this.generation !== attempt || !this.controllers.has(id)) return;
    this.controllers.delete(id);
    this.publish(this.items.map((item) => item.id !== id ? item : meta
      ? { ...item, status: 'done', progress: 100, meta, errorMsg: undefined }
      : { ...item, status: 'error', errorMsg: errorMessage(error) }));
    this.pump();
  }

  loadPreviews(items: AttachmentUploadItem[]): void {
    items.filter(needsPreview).forEach((item) => this.startPreview(item));
  }

  private startPreview(item: AttachmentUploadItem): void {
    if (this.requestedPreviews.has(item.id)) return;
    this.requestedPreviews.add(item.id);
    const attempt = this.generation;
    void this.options.fetchPreview(item.meta!.path).then((url) => {
      this.requestedPreviews.delete(item.id);
      const live = this.items.some((entry) => entry.id === item.id && !entry.previewUrl);
      if (this.generation !== attempt || !live) { this.revoke(url); return; }
      this.publish(this.items.map((entry) => entry.id === item.id ? { ...entry, previewUrl: url } : entry));
    }).catch(() => this.requestedPreviews.delete(item.id));
  }
}
