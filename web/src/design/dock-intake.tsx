import { createContext, useContext } from 'react';
import type { PreviewItem } from '@/features/media/preview-item';

// The seam between the dock and the surfaces that open into it.
//
// Four surfaces hand a preview to the dock — the media lightbox, the document modal, an agent view
// card's ◧ button, and the Web button — and all four live in features that the dock itself renders
// into: the dock mounts the media bodies and the browser's WebBody. Calling `useDock()` from them
// therefore made browser<->dock and media<->dock mutual, which is the pair the allow-list carried.
//
// So the intake is declared HERE, below both, and the dock supplies it: `features/dock` still owns
// every bit of the state (tab list, split, persistence, host registration) and still renders the
// bodies, but the direction is now one-way. The `PreviewItem` import is type-only — it names what the
// dock accepts, from the leaf module that declares it, without putting a feature in this module's
// runtime graph.

export interface DockIntakeValue {
  /** A host is mounted → previews CAN be docked (the modals show their ◧ button). */
  canDock: boolean;
  /** The dock is open AND a host is mounted → openMedia / openDoc route to a tab. */
  active: boolean;
  /** What the dock is showing right now, for surfaces that reflect it (the Web button's pressed state). */
  activeKind: 'file' | 'web' | null;
  /** Preview a file in the dock: opens it, and focuses the tab if that file is already open. */
  openFile: (item: PreviewItem) => void;
  /** Open the dock on a web tab, reusing a blank one when there is one. */
  openWeb: () => void;
}

// No dock in scope (mobile shell, isolated component tests) → inert: nothing can dock, so every
// surface keeps its modal behaviour unchanged.
const DockIntakeContext = createContext<DockIntakeValue>({
  canDock: false,
  active: false,
  activeKind: null,
  openFile: () => {},
  openWeb: () => {},
});

export const DockIntakeProvider = DockIntakeContext.Provider;

export function useDockIntake(): DockIntakeValue {
  return useContext(DockIntakeContext);
}
