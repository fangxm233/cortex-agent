// input:  React, floating composer shell dimensions
// output: useComposerClearance
// pos:    Measure mobile transcript clearance for its composer
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useEffect, useRef, useState } from 'react';

export function useComposerClearance() {
  const composerRef = useRef<HTMLDivElement>(null);
  const [tailHeight, setTailHeight] = useState(150);
  useEffect(() => {
    const shell = composerRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    // Preserve the original 150px tail for the 94px single-line shell. The 56px
    // remainder includes the existing 20px bottom offset; safe-area and the
    // transcript's 16px flex gap remain in MChatView. Measure the whole shell so
    // attachments, reject bars and wrapping all reserve the same boundary.
    const measure = () => setTailHeight(Math.max(150, shell.getBoundingClientRect().height + 56));
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(shell, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);
  return { composerRef, tailHeight };
}
