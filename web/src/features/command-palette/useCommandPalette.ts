import { useEffect, useState } from 'react';

/**
 * Global ⌘K / Ctrl+K toggle for the command palette. Installs one window keydown
 * listener (cleaned up on unmount) and returns the controlled open state. ⌘K works
 * from anywhere, including while focused in an input (cmdk convention).
 */
export function useCommandPalette(): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key?.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return { open, setOpen };
}
