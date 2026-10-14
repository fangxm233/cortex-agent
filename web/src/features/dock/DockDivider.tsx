import { useRef, type RefObject } from 'react';
import { splitFromDrag } from './dock-split';

// The chat | dock divider, on the dock pane's left edge. Pointer capture keeps the drag alive while
// the pointer crosses an iframe (a web tab, an HTML preview, a board, an HTML card in the chat):
// without it the frame swallows the moves and the release, so the drag stalls and stays armed until
// the next click. During the drag the two panes' flex-grow is written straight onto their elements,
// so a move costs one layout rather than a re-render of the chat and every dock body; the ratio
// reaches state once, on release. React's own props then carry the same values.

export function DockDivider({ split, label, paneRef, onCommit }: {
  split: number;
  label: string;
  /** The dock pane; the chat pane is its preceding sibling. */
  paneRef: RefObject<HTMLElement>;
  onCommit: (split: number) => void;
}): JSX.Element {
  const drag = useRef<{ pane: HTMLElement; chat: HTMLElement; left: number; width: number; last: number } | null>(null);

  const end = (): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.style.userSelect = '';
    onCommit(d.last);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={label}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const pane = paneRef.current;
        const chat = pane?.previousElementSibling as HTMLElement | null;
        if (!pane || !chat) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const paneRect = pane.getBoundingClientRect();
        const chatRect = chat.getBoundingClientRect();
        drag.current = { pane, chat, left: chatRect.left, width: chatRect.width + paneRect.width, last: split };
        document.body.style.userSelect = 'none';
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const next = splitFromDrag(d.left, d.width, e.clientX);
        if (next === d.last) return;
        d.last = next;
        d.pane.style.flexGrow = String(next);
        d.chat.style.flexGrow = String(1 - next);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 10, cursor: 'col-resize', zIndex: 3, touchAction: 'none' }}
    />
  );
}
