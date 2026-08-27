// input:  Attachment scope/bucket, local files, restored metadata, and upload dependencies
// output: Shared three-lane FIFO upload controller with retry, abort, progress, and preview lifecycle
// pos:    Headless desktop/mobile attachment queue controller
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { AttachmentUploadStore, type AttachmentStoreOptions } from './attachment-upload-store';
import { completedAttachmentMetas, type AttachmentMeta, type AttachmentUploadItem } from './types';

export interface AttachmentUploadController {
  items: AttachmentUploadItem[];
  completed: AttachmentMeta[];
  hasNonDone: boolean;
  addFiles: (files: FileList | File[]) => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
  replaceRestored: (metas: AttachmentMeta[]) => void;
  mergeRestored: (metas: AttachmentMeta[]) => void;
  reset: () => void;
}

export type UseAttachmentUploadsOptions = AttachmentStoreOptions;

export function useAttachmentUploads(options: UseAttachmentUploadsOptions): AttachmentUploadController {
  const storeRef = useRef<AttachmentUploadStore>();
  if (!storeRef.current) storeRef.current = new AttachmentUploadStore(options);
  const store = storeRef.current;
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useLayoutEffect(() => store.bind(options), [options.bucket, options.concurrency, options.fetchPreview, options.scope, options.transport, store]);
  useEffect(() => { store.loadPreviews(items); }, [items, store]);
  useEffect(() => {
    store.cancelDisposal();
    return () => store.scheduleDisposal();
  }, [store]);
  return {
    items,
    completed: completedAttachmentMetas(items),
    hasNonDone: items.some((item) => item.status !== 'done'),
    addFiles: store.addFiles,
    remove: store.remove,
    retry: store.retry,
    replaceRestored: store.replaceRestored,
    mergeRestored: store.mergeRestored,
    reset: store.reset,
  };
}
