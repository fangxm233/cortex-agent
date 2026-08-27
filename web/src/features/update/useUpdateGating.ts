// input:  pending update values and the currently focused DOM element
// output: pending values delayed until text-editing focus has ended
// pos:    Surface-neutral headless typing gate shared by both update hooks
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useState } from 'react';

const NON_TEXT_INPUTS = ['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'];

export function isEditableTarget(element: Element | null): boolean {
  if (!element) return false;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName === 'INPUT') {
    return !NON_TEXT_INPUTS.includes((element as HTMLInputElement).type);
  }
  return (element as HTMLElement).isContentEditable === true;
}

function editingIsActive(): boolean {
  return typeof document !== 'undefined' && isEditableTarget(document.activeElement);
}

export function useUpdateGating<T>(pending: T | null): T | null {
  const [shown, setShown] = useState<T | null>(null);
  useEffect(() => {
    if (pending === null) {
      setShown(null);
      return;
    }
    const surface = () => {
      if (!editingIsActive()) setShown(pending);
    };
    surface();
    if (typeof document === 'undefined') return;
    const onFocusOut = () => window.setTimeout(surface, 0);
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, [pending]);
  return pending === shown ? shown : null;
}
