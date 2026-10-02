import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Measure untransformed content, then cap the numeric target before starting the transition.
 * Animating an uncapped height under max-height would delay shrinking a long list. */
export function useSheetHeight(enabled: boolean, children: ReactNode) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  const measure = (): void => {
    const [host, sheet, scroll, content] = [hostRef.current, sheetRef.current, scrollRef.current, contentRef.current];
    if (!enabled || !host || !sheet || !scroll || !content) return;
    const available = host.clientHeight - parseFloat(getComputedStyle(host).paddingTop);
    const chrome = scroll.offsetTop + parseFloat(getComputedStyle(sheet).paddingBottom);
    setHeight(Math.max(0, Math.min(content.offsetHeight + chrome, available)));
  };
  useLayoutEffect(measure, [enabled, children]);
  useLayoutEffect(() => {
    if (!enabled || !hostRef.current || !contentRef.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(hostRef.current);
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [enabled]);
  return { hostRef, sheetRef, scrollRef, contentRef, height: enabled ? height : undefined };
}
