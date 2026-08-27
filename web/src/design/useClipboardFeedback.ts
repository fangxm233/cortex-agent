// input:  clipboard text, feedback keys, and reset duration
// output: success-only copied feedback state and an async copy action
// pos:    Shared clipboard-feedback lifecycle hook for desktop and mobile views
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ClipboardFeedback<Key> {
  copiedKey: Key | null;
  copy: (text: string, key: Key) => Promise<boolean>;
}

export function useClipboardFeedback<Key>(resetMs = 1400): ClipboardFeedback<Key> {
  const [copiedKey, setCopiedKey] = useState<Key | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
  const copy = useCallback(async (text: string, key: Key): Promise<boolean> => {
    const request = ++requestRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (mountedRef.current) setCopiedKey(null);
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) return false;
    try { await clipboard.writeText(text); } catch { return false; }
    if (!mountedRef.current || request !== requestRef.current) return true;
    setCopiedKey(key);
    timerRef.current = setTimeout(() => setCopiedKey(null), resetMs);
    return true;
  }, [resetMs]);
  return { copiedKey, copy };
}
