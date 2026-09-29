import { useCallback, useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';

/**
 * Inline rails sit in the composer's own row, outside the transcript, so a faint tint is enough.
 * A floating composer (mobile) hangs over the scrolling transcript: the rail then needs the same
 * frosted chrome as the composer card below it, or the messages behind show straight through.
 */
export function railSurface(floating: boolean): CSSProperties {
  return {
    border: '1px solid var(--proto-line)',
    borderRadius: 'var(--r-control)',
    marginBottom: 8,
    overflow: 'hidden',
    animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both',
    ...(floating
      ? {
          background: 'var(--glass-1)',
          backdropFilter: 'var(--glass-filter)',
          WebkitBackdropFilter: 'var(--glass-filter)',
          boxShadow: 'var(--shadow-chrome-float)',
        }
      : { background: 'var(--proto-alt)' }),
  };
}

/** Expanded state is per session and persisted under `storageKey`, matching the left rail's
 *  SCHEDULED zone. Collapsed is the default: a rail exists to be glanceable, and auto-expanding
 *  would move the composer under the user's cursor mid-turn. */
export function useExpanded(storageKey: string): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { setOpen(window.localStorage.getItem(storageKey) === '1'); }
    catch { setOpen(false); }
  }, [storageKey]);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, [storageKey]);
  return [open, toggle];
}

/** Enter/Space on the expanded rail collapses it, like a click. */
export function collapseOnKeyDown(toggle: () => void): (event: KeyboardEvent<HTMLDivElement>) => void {
  return (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  };
}
