import { useCallback, useEffect, useState } from 'react';

/** Tracks an element's content width; `fallback` until the first measure (and where there is no
 *  ResizeObserver, e.g. a test renderer). */
export function useElementWidth<T extends HTMLElement>(fallback: number): [(node: T | null) => void, number] {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setWidth(Math.max(0, Math.floor(node.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [useCallback((next: T | null) => setNode(next), []), width];
}
