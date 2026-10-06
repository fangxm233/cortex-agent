import { useCallback, useEffect, useState } from 'react';
import { useBackDismiss } from '@/design/use-back-dismiss';
import { useDockIntake } from '@/design/dock-intake';
import type { PreviewItem } from './preview-item';

// What the two full-screen previewers (the media lightbox and the document modal) share: the
// chrome every open modal needs, and the provider state that decides between the modal and the dock.

/** While a preview modal is mounted: Esc and the Android / browser back close it, and the page
 *  behind it does not scroll. */
export function usePreviewModalChrome(onClose: () => void): void {
  useBackDismiss(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);
}

export interface PreviewHost<T extends PreviewItem> {
  /** The item the modal shows, if any. */
  item: T | null;
  /** Opens `next` in the modal — or, while the dock is open, opens (or focuses) its dock tab. */
  open: (next: T) => void;
  close: () => void;
  /** ◧: hands the open item to a dock tab and dismisses the modal. Absent where no dock exists. */
  pin?: () => void;
}

export function usePreviewHost<T extends PreviewItem>(): PreviewHost<T> {
  const [item, setItem] = useState<T | null>(null);
  const dock = useDockIntake();
  const open = useCallback(
    (next: T) => {
      if (dock.active) {
        dock.openFile(next);
        return;
      }
      setItem(next);
    },
    [dock],
  );
  const close = useCallback(() => setItem(null), []);
  const pin = dock.canDock
    ? () => {
        if (item) dock.openFile(item);
        setItem(null);
      }
    : undefined;
  return { item, open, close, pin };
}
