import { useEffect, useState, type RefObject } from 'react';

/** True once `hostRef` has come within 400px of the viewport, and from then on. Gates fetching
 *  media that a long transcript would otherwise load all at once. */
export function useNearViewport(hostRef: RefObject<HTMLElement>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = hostRef.current;
    if (!element || visible) return;
    if (typeof IntersectionObserver !== 'function') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '400px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hostRef, visible]);
  return visible;
}
