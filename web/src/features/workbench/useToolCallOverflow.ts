// input:  tool labels, chip measurement elements, container width
// output: refs and responsive visible/hidden tool-call layout
// pos:    Shared Desktop/Mobile collapsed tool-call measurement hook
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { toolCallOverflowLayout, type ToolCallOverflowLayout } from './tool-call-overflow';

export interface ToolCallOverflowRefs {
  containerRef: RefObject<HTMLSpanElement>;
  measureRef: RefObject<HTMLSpanElement>;
  layout: ToolCallOverflowLayout;
}

function measuredWidths(measure: HTMLSpanElement, count: number): { chipWidths: number[]; overflowWidth: number } {
  const children = Array.from(measure.children) as HTMLElement[];
  return {
    chipWidths: children.slice(0, count).map((child) => child.getBoundingClientRect().width),
    overflowWidth: children[count]?.getBoundingClientRect().width ?? 0,
  };
}

function sameLayout(left: ToolCallOverflowLayout, right: ToolCallOverflowLayout): boolean {
  return left.visibleCount === right.visibleCount && left.hiddenCount === right.hiddenCount;
}

function observeWidth(container: HTMLSpanElement, recalculate: () => void): () => void {
  let active = true;
  const guardedRecalculate = (): void => { if (active) recalculate(); };
  guardedRecalculate();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(guardedRecalculate);
  observer?.observe(container);
  void document.fonts?.ready.then(guardedRecalculate);
  return () => { active = false; observer?.disconnect(); };
}

export function useToolCallOverflow(labels: string[], gap: number): ToolCallOverflowRefs {
  const containerRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [layout, setLayout] = useState<ToolCallOverflowLayout>({ visibleCount: labels.length, hiddenCount: 0 });
  const labelsKey = labels.join('\0');
  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;
    return observeWidth(container, () => {
      const widths = measuredWidths(measure, labels.length);
      const next = toolCallOverflowLayout({ availableWidth: container.clientWidth, ...widths, gap });
      setLayout((current) => sameLayout(current, next) ? current : next);
    });
  }, [gap, labels.length, labelsKey]);
  return { containerRef, measureRef, layout };
}
