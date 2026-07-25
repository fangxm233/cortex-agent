import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  clampPreviewSplit,
  parsePreviewPinned,
  parsePreviewSplit,
  PREVIEW_PINNED_KEY,
  PREVIEW_SPLIT_DEFAULT,
  PREVIEW_SPLIT_KEY,
  type PreviewItem,
} from './pinned-preview';

// PINNED PREVIEW state — the docked (split-view) alternative to the full-screen preview modal.
//
// Default mode: clicking a previewable image / video / document raises the MediaViewer lightbox or
// the DocViewer modal. Pressing the modal's ◧ button PINS the preview: the workbench center region
// splits into chat (left) + a docked preview pane (right), and from then on every preview click
// swaps the pane's content instead of raising a modal. The pane's × unpins, restoring modal mode.
//
// `canPin` / `active` are gated on a mounted dock host (`PinnedPreviewPane`, rendered only by the
// desktop workbench frame) — so the ◧ button never appears, and pinned mode never swallows a
// preview, on a surface that has nowhere to dock it (mobile shell, thread detail route, …).
// The provider owns no viewer imports; MediaViewer / DocViewer consume it (no cycle).

interface PinnedPreviewContextValue {
  /** A dock host is mounted → previews CAN be pinned (the modals show their ◧ button). */
  canPin: boolean;
  /** Pinned mode is on AND a dock host is mounted → openMedia / openDoc route to the pane. */
  active: boolean;
  /** The pinned-mode flag itself (persisted); the pane renders whenever this is on. */
  pinned: boolean;
  item: PreviewItem | null;
  /** The preview pane's share of the center region (chat + preview). */
  split: number;
  /** Turn on pinned mode, optionally seeding it with the item currently in the modal. */
  pin: (item?: PreviewItem | null) => void;
  /** Swap the docked pane's content (what a preview click does while `active`). */
  show: (item: PreviewItem) => void;
  /** Close the pane and restore the modal preview mode. */
  unpin: () => void;
  /** Live during a divider drag; `persist` on drag end. */
  setSplit: (value: number, persist?: boolean) => void;
  /** Mounted by the pane; returns the unregister callback. */
  registerHost: () => () => void;
}

// No provider in scope (mobile shell, isolated component tests) → inert: nothing can pin, so both
// viewers keep their modal behavior unchanged.
const PinnedPreviewContext = createContext<PinnedPreviewContextValue>({
  canPin: false,
  active: false,
  pinned: false,
  item: null,
  split: PREVIEW_SPLIT_DEFAULT,
  pin: () => {},
  show: () => {},
  unpin: () => {},
  setSplit: () => {},
  registerHost: () => () => {},
});

function initialPinned(): boolean {
  try {
    return parsePreviewPinned(window.localStorage.getItem(PREVIEW_PINNED_KEY));
  } catch {
    return false;
  }
}

function initialSplit(): number {
  try {
    return parsePreviewSplit(window.localStorage.getItem(PREVIEW_SPLIT_KEY));
  } catch {
    return PREVIEW_SPLIT_DEFAULT;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* persistence is best-effort (SSR / private mode) */
  }
}

export function PinnedPreviewProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pinned, setPinned] = useState(initialPinned);
  const [item, setItem] = useState<PreviewItem | null>(null);
  const [split, setSplitState] = useState(initialSplit);
  const [hosts, setHosts] = useState(0);

  const registerHost = useCallback(() => {
    setHosts((n) => n + 1);
    return () => setHosts((n) => Math.max(0, n - 1));
  }, []);

  const pin = useCallback((next?: PreviewItem | null) => {
    setPinned(true);
    store(PREVIEW_PINNED_KEY, '1');
    if (next) setItem(next);
  }, []);

  const show = useCallback((next: PreviewItem) => setItem(next), []);

  const unpin = useCallback(() => {
    setPinned(false);
    store(PREVIEW_PINNED_KEY, '0');
    setItem(null);
  }, []);

  const setSplit = useCallback((value: number, persist = false) => {
    const next = clampPreviewSplit(value);
    setSplitState(next);
    if (persist) store(PREVIEW_SPLIT_KEY, String(next));
  }, []);

  const value = useMemo<PinnedPreviewContextValue>(
    () => ({
      canPin: hosts > 0,
      active: pinned && hosts > 0,
      pinned,
      item,
      split,
      pin,
      show,
      unpin,
      setSplit,
      registerHost,
    }),
    [hosts, pinned, item, split, pin, show, unpin, setSplit, registerHost],
  );

  return <PinnedPreviewContext.Provider value={value}>{children}</PinnedPreviewContext.Provider>;
}

export function usePinnedPreview(): PinnedPreviewContextValue {
  return useContext(PinnedPreviewContext);
}
