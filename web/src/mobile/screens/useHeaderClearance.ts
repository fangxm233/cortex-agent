import { useLayoutEffect, useRef } from 'react';

/** The floating header stack's bottom edge, measured from the top of the chat screen. */
export const HEADER_BOTTOM_VAR = '--chat-header-bottom';

/**
 * The header pill and, in team mode, the worker strip under it float over the transcript as one
 * stack. Its bottom edge — safe-area inset included — is measured here and published as one CSS
 * variable on the screen root; the transcript's top clearance and fade and the ⋯ menu's anchor all
 * derive from it, so none of them restates the header's geometry.
 */
export function useHeaderClearance() {
  const rootRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const stack = stackRef.current;
    if (!root || !stack) return;
    // Written straight onto the root rather than through state: it is in place before the first
    // paint and before the transcript first sticks to its bottom (a padding that arrived a render
    // later would grow the content under that first stick), and a resize re-renders nothing.
    const publish = (): void => {
      const bottom = stack.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
      root.style.setProperty(HEADER_BOTTOM_VAR, `${bottom}px`);
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    // The stack grows with the strip; the root catches a safe-area change (rotation).
    const observer = new ResizeObserver(publish);
    observer.observe(stack);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return { rootRef, stackRef };
}
