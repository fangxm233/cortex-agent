import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyFrontendUpdate,
  getStagedUpdate,
  onFrontendUpdateStaged,
  type StagedUpdate,
} from './frontend-update';

// Drives the hot-update prompt (design scheme.dc.html 21a / scheme-mobile 3a). Subscribes to the
// native shell's `frontend-update-staged` event (+ a mount-time backstop query for a missed event),
// and exposes the staged update to show plus apply/dismiss actions. Off-shell (browser / ui-http) the
// seam is a no-op, so `staged` stays null and no prompt ever renders — the prompt is APP-only.
//
// Gating (design 21a "下载完成不立刻弹——等 composer 无输入焦点…"): if a text input is focused when the
// update arrives, showing is DEFERRED until focus leaves it, so the prompt never interrupts typing.
// (The design also defers while an approval/diff is open — left as a documented follow-up; the focus
// gate covers the common composer-typing case.)

/** True when the focused element is a text-editing surface (input / textarea / contenteditable), where
 *  popping a modal would interrupt the user. Pure over the passed element so it is unit-testable. */
export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    // Buttons/checkboxes/etc. are not text entry — only guard genuine text fields.
    const nonText = ['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'];
    return !nonText.includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

export interface HotUpdateState {
  staged: StagedUpdate | null;
  apply: () => void;
  dismiss: () => void;
}

export function useHotUpdate(): HotUpdateState {
  const [staged, setStaged] = useState<StagedUpdate | null>(null);
  // Ignored for this run (design 21a "忽略：本次运行内不再弹") — a ref so callbacks read the latest.
  const dismissedRef = useRef(false);
  // Held here while a text input is focused; surfaced when focus leaves.
  const pendingRef = useRef<StagedUpdate | null>(null);

  const tryShow = useCallback((update: StagedUpdate) => {
    if (dismissedRef.current) return;
    if (isEditableTarget(typeof document !== 'undefined' ? document.activeElement : null)) {
      pendingRef.current = update; // defer past the focus gate
      return;
    }
    setStaged(update);
  }, []);

  // Subscribe to the staged-update event + query the backstop once on mount.
  useEffect(() => {
    let cancelled = false;
    let unlisten = () => {};
    void onFrontendUpdateStaged((u) => tryShow(u)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    void getStagedUpdate().then((u) => {
      if (u && !cancelled) tryShow(u);
    });
    return () => {
      cancelled = true;
      unlisten();
    };
  }, [tryShow]);

  // When focus leaves a text field, surface any deferred update (re-check the gate first).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onFocusOut = () => {
      // Defer a tick so document.activeElement settles after the blur.
      window.setTimeout(() => {
        if (dismissedRef.current || !pendingRef.current) return;
        if (!isEditableTarget(document.activeElement)) {
          setStaged(pendingRef.current);
          pendingRef.current = null;
        }
      }, 0);
    };
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, []);

  const apply = useCallback(() => {
    void applyFrontendUpdate();
  }, []);

  const dismiss = useCallback(() => {
    dismissedRef.current = true;
    pendingRef.current = null;
    setStaged(null);
  }, []);

  return { staged, apply, dismiss };
}
