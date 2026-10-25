import { useState } from 'react';
import { createPortal } from 'react-dom';
import { MENU_INSET, MENU_SURFACE, MenuRow, useDismissMenu } from '@/design/MenuChrome';
import { useVocabOptional } from '@/i18n';

// A tab's right-click menu: pin or unpin it, or close it. It is the only way to close a pinned
// tab, whose ✕ became its pin. Portalled to the body, since the pane's glass ancestors would
// otherwise become the containing block of a `position: fixed` card and clip it.

export interface TabMenuTarget {
  id: string;
  x: number;
  y: number;
}

const MENU_WIDTH = 180;

export function DockTabMenu({ target, pinned, onPin, onUnpin, onClose, onDismiss }: {
  target: TabMenuTarget;
  pinned: boolean;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onClose: (id: string) => void;
  onDismiss: () => void;
}): JSX.Element {
  const L = useVocabOptional();
  const [hover, setHover] = useState<string | null>(null);
  useDismissMenu(true, onDismiss, onDismiss);
  const pick = (run: (id: string) => void) => () => {
    onDismiss();
    run(target.id);
  };
  const left = Math.max(4, Math.min(target.x, window.innerWidth - MENU_WIDTH - 4));
  return createPortal(
    <div data-menu="dock-tab" role="menu" onContextMenu={(event) => event.preventDefault()} style={{
      position: 'fixed', left, top: target.y, zIndex: 60, minWidth: MENU_WIDTH, padding: MENU_INSET,
      ...MENU_SURFACE, border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)',
    }}>
      <MenuRow id="pin" label={pinned ? L.dockUnpinTab : L.dockPinTab} active={false}
        onPick={pick(pinned ? onUnpin : onPin)} hover={hover} setHover={setHover} />
      <MenuRow id="close" label={L.dockCloseTab} active={false} onPick={pick(onClose)} hover={hover} setHover={setHover} />
    </div>,
    document.body,
  );
}

/** A pushpin as line art, for a pinned tab's trailing button. */
export function PinGlyph({ size = 11 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flex: 'none' }}>
      <path d="M5.5 2.5h5M6.5 2.5v3.5L4.5 8.5h7L9.5 6V2.5M8 8.5v5" />
    </svg>
  );
}
