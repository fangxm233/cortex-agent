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
  /** Where `item` sits in the group it was opened from; a lone item is 0 of 1. */
  index: number;
  count: number;
  /** Opens `next` in the modal — or, while the dock is open, opens (or focuses) its dock tab.
   *  `group` (which must contain `next`) is what `step` moves through. */
  open: (next: T, group?: readonly T[]) => void;
  /** Shows the previous (-1) or next (+1) item of the group; stops at either end. */
  step: (delta: number) => void;
  close: () => void;
  /** ◧: hands the shown item to a dock tab and dismisses the modal. Absent where no dock exists. */
  pin?: () => void;
}

interface Shown<T> {
  items: readonly T[];
  index: number;
}

function shownFrom<T>(next: T, group: readonly T[] | undefined): Shown<T> {
  const index = group ? group.indexOf(next) : -1;
  return index < 0 ? { items: [next], index: 0 } : { items: group!, index };
}

function stepped<T>(shown: Shown<T> | null, delta: number): Shown<T> | null {
  if (!shown) return null;
  const index = Math.min(Math.max(shown.index + delta, 0), shown.items.length - 1);
  return index === shown.index ? shown : { ...shown, index };
}

export function usePreviewHost<T extends PreviewItem>(): PreviewHost<T> {
  const [shown, setShown] = useState<Shown<T> | null>(null);
  const dock = useDockIntake();
  const item = shown ? shown.items[shown.index] : null;
  const open = useCallback(
    (next: T, group?: readonly T[]) => {
      if (dock.active) {
        dock.openFile(next);
        return;
      }
      setShown(shownFrom(next, group));
    },
    [dock],
  );
  const step = useCallback((delta: number) => setShown((cur) => stepped(cur, delta)), []);
  const close = useCallback(() => setShown(null), []);
  const pin = dock.canDock
    ? () => {
        if (item) dock.openFile(item);
        setShown(null);
      }
    : undefined;
  return { item, index: shown?.index ?? 0, count: shown?.items.length ?? 0, open, step, close, pin };
}
