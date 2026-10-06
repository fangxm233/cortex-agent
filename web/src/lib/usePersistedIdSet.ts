import { useCallback, useMemo, useState } from 'react';

function load(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function save(key: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* persistence is best-effort */
  }
}

export interface PersistedIdSet {
  ids: ReadonlySet<string>;
  toggle: (id: string) => void;
  add: (id: string) => void;
  remove: (id: string) => void;
}

/** A set of ids persisted to localStorage as a JSON array (disclosure state: open folders and the
 *  like). Unreadable storage starts empty; writes are best-effort. A no-op add/remove keeps the
 *  same set, so it does not re-render. */
export function usePersistedIdSet(key: string): PersistedIdSet {
  const [ids, setIds] = useState<Set<string>>(() => load(key));
  const update = useCallback((change: (prev: Set<string>) => Set<string>) => {
    setIds((prev) => {
      const next = change(prev);
      if (next !== prev) save(key, next);
      return next;
    });
  }, [key]);
  const toggle = useCallback((id: string) => update((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  }), [update]);
  const add = useCallback((id: string) => update((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), [update]);
  const remove = useCallback((id: string) => update((prev) => {
    if (!prev.has(id)) return prev;
    const next = new Set(prev);
    next.delete(id);
    return next;
  }), [update]);
  return useMemo(() => ({ ids, toggle, add, remove }), [ids, toggle, add, remove]);
}
