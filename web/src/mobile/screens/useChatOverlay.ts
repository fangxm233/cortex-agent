import { useState } from 'react';

/** The chat's menus and sheets. Only one is ever up: each one's backdrop covers the triggers of the
 *  others, so opening one from inside another (⋯ → Session ID, ＋ → browser) is a hand-over. */
export type ChatOverlayKind = 'more' | 'sessionId' | 'stats' | 'attach' | 'browser' | 'commission' | 'context' | 'team';

type OverlayState = { kind: ChatOverlayKind } | { kind: 'original'; text: string } | null;

export interface ChatOverlay {
  is: (kind: ChatOverlayKind) => boolean;
  /** The pre-edit text the original-message sheet shows; null while it is closed. */
  originalText: string | null;
  open: (kind: ChatOverlayKind) => void;
  toggle: (kind: ChatOverlayKind) => void;
  showOriginal: (text: string) => void;
  /** Closes `kind` only if it is still the one up, so a menu closing itself after handing over to a
   *  sheet does not take the sheet down with it. */
  close: (kind: ChatOverlayKind | 'original') => void;
}

/** Presentation state only: nothing outside the view reads it. A new `scope` (another session)
 *  starts with everything closed. */
export function useChatOverlay(scope: string): ChatOverlay {
  const [state, setState] = useState<{ scope: string; overlay: OverlayState }>({ scope, overlay: null });
  const overlay = state.scope === scope ? state.overlay : null;
  const update = (next: (current: OverlayState) => OverlayState): void => {
    setState((prev) => ({ scope, overlay: next(prev.scope === scope ? prev.overlay : null) }));
  };
  return {
    is: (kind) => overlay?.kind === kind,
    originalText: overlay?.kind === 'original' ? overlay.text : null,
    open: (kind) => update(() => ({ kind })),
    toggle: (kind) => update((current) => (current?.kind === kind ? null : { kind })),
    showOriginal: (text) => update(() => ({ kind: 'original', text })),
    close: (kind) => update((current) => (current?.kind === kind ? null : current)),
  };
}
