// input:  React style types, shared theme tokens
// output: railSurface
// pos:    Shared surface for the composer's todo and wait rails
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import type { CSSProperties } from 'react';

/**
 * Inline rails sit in the composer's own row, outside the transcript, so a faint tint is enough.
 * A floating composer (mobile) hangs over the scrolling transcript: the rail then needs the same
 * frosted chrome as the composer card below it, or the messages behind show straight through.
 */
export function railSurface(floating: boolean): CSSProperties {
  return {
    border: '1px solid var(--proto-line)',
    borderRadius: 'var(--r-control)',
    marginBottom: 8,
    overflow: 'hidden',
    animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both',
    ...(floating
      ? {
          background: 'var(--glass-1)',
          backdropFilter: 'var(--glass-filter)',
          WebkitBackdropFilter: 'var(--glass-filter)',
          boxShadow: 'var(--shadow-chrome-float)',
        }
      : { background: 'var(--proto-alt)' }),
  };
}
