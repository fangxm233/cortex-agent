import { useCallback, useState } from 'react';

const KEY = 'cortex.projectStarsCollapsed';

function loadCollapsed(): Set<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function persist(value: Set<string>): Set<string> {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...value]));
  } catch {
    // Like other rail disclosures, persistence is best effort.
  }
  return value;
}

/** Open by default, independently collapsible for each project on either list surface. */
export function useStarredGroups() {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = useCallback((projectId: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    return persist(next);
  }), []);
  const reveal = useCallback((projectId: string) => setCollapsed((previous) => {
    if (!previous.has(projectId)) return previous;
    const next = new Set(previous);
    next.delete(projectId);
    return persist(next);
  }), []);
  return { collapsed, toggle, reveal };
}
