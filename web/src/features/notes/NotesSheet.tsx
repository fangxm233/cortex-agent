import { useLayoutEffect, useRef, useState } from 'react';
import { NotesGlyph } from './NotesGlyph';
import { NotesPane } from './NotesPane';
import { useNotes } from './NotesProvider';
import { NOTES_SHEET_CORNER, NOTES_SHEET_WIDTH, notesSheetPlacement, type NotesSheetPlacement } from './notes-vm';

// Notes opens as a card hanging under the header button that toggles it (ChatHeader, Overview), or
// in the pane's top-right corner on pages without one. Its height follows the list, so the
// composer below stays in view for "hand off". Rendered inside the WorkspacePanel of every route.

function measure(sheet: HTMLElement | null): NotesSheetPlacement | null {
  const pane = sheet?.offsetParent;
  if (!(pane instanceof HTMLElement)) return null;
  const trigger = pane.querySelector('[data-notes-button]');
  return notesSheetPlacement(pane.getBoundingClientRect(), trigger?.getBoundingClientRect() ?? null);
}

export function NotesSheet(): JSX.Element {
  const notes = useNotes();
  const sheetRef = useRef<HTMLDivElement>(null);
  // Closing keeps the card on screen for its fade; adjusted during render so the first closed
  // frame already animates out.
  const [closing, setClosing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(notes.isOpen);
  if (notes.isOpen !== prevOpen) {
    setPrevOpen(notes.isOpen);
    setClosing(!notes.isOpen);
  }
  const shown = notes.isOpen || closing;
  const [place, setPlace] = useState<NotesSheetPlacement>(NOTES_SHEET_CORNER);
  useLayoutEffect(() => {
    if (!notes.isOpen) return;
    const update = () => {
      const next = measure(sheetRef.current);
      if (next) setPlace(next);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [notes.isOpen]);

  return (
    <>
      {/* Click-catcher: clicking the covered content is the natural "done with this" gesture. */}
      {notes.isOpen && (
        <div onClick={notes.close} style={{ position: 'absolute', inset: 0, zIndex: 5, background: 'transparent', cursor: 'default' }} />
      )}
      {/* `display` rather than unmounting, so an unsent draft survives closing. This card is the
          one `backdrop-filter` in the pane: nothing inside it may blur. */}
      <div
        ref={sheetRef}
        data-notes-sheet=""
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && closing) setClosing(false);
        }}
        style={{
          position: 'absolute',
          top: place.top,
          right: place.right,
          zIndex: 6,
          width: NOTES_SHEET_WIDTH,
          maxHeight: `min(620px, calc(100% - ${place.top + 12}px))`,
          display: shown ? 'flex' : 'none',
          flexDirection: 'column',
          minHeight: 0,
          overflow: 'hidden',
          pointerEvents: closing ? 'none' : 'auto',
          borderRadius: 'var(--r-float)',
          background: 'var(--glass-2)',
          backdropFilter: 'var(--glass-filter)',
          WebkitBackdropFilter: 'var(--glass-filter)',
          boxShadow: 'var(--shadow-float)',
          transformOrigin: 'top right',
          animation: closing
            ? 'cxfadeout 120ms ease-in forwards'
            : 'cxpop 160ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <NotesPane headerIcon={<NotesGlyph size={14} />} visible={notes.isOpen} />
      </div>
    </>
  );
}
