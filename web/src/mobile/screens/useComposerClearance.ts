import { useEffect, useRef, useState } from 'react';

export function useComposerClearance() {
  const composerRef = useRef<HTMLDivElement>(null);
  const [shellHeight, setShellHeight] = useState(94);
  useEffect(() => {
    const shell = composerRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    // Measure the whole shell so attachments, reject bars and wrapping all reserve the same boundary.
    const measure = () => setShellHeight(shell.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(shell, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);
  // Preserve the original 150px tail for the 94px single-line shell. The 56px remainder includes
  // the shell's 20px bottom offset; safe-area and the transcript's 16px flex gap remain in MChatView.
  // That leaves the last row 52px clear of the shell top, which is what the transcript fade spends.
  const tailHeight = Math.max(150, shellHeight + 56);
  return { composerRef, tailHeight, shellHeight };
}
