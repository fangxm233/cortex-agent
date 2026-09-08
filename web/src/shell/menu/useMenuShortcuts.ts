// input:  the assembled menu model and DOM key events
// output: one global keydown handler that runs every accelerator the menus declare
// pos:    Replaces the app's ad-hoc per-feature shortcut listeners
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useEffect } from 'react';
import { accelItems, matchesAccel, type MenuDef } from './menu-model';

// Typing must win over accelerators, otherwise Ctrl+A in the composer would run the menu item
// instead of selecting the message text. The two exceptions are the palette (⌘K) and the window
// commands, which the previous ad-hoc handler also fired from inside inputs — but those either
// carry a modifier the editor does not use, or are the user explicitly leaving the field.
const EDITABLE = /^(input|textarea)$/i;
const ALWAYS_ACTIVE = new Set(['edit.palette', 'file.newSession', 'view.fullscreen']);

function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return EDITABLE.test(target.tagName) || target.isContentEditable;
}

export function useMenuShortcuts(menus: MenuDef[]): void {
  useEffect(() => {
    const items = accelItems(menus);
    const onKeyDown = (event: KeyboardEvent) => {
      const editing = inTextField(event.target);
      for (const item of items) {
        if (item.disabled || item.accelDisplayOnly) continue;
        if (editing && !ALWAYS_ACTIVE.has(item.id)) continue;
        if (!matchesAccel(event, item.accel)) continue;
        event.preventDefault();
        item.run();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menus]);
}
