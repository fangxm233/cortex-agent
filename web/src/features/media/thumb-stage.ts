import type { CSSProperties } from 'react';

/** Diagonal stripes a thumbnail shows while its bytes are still on the way. */
export const stageFallback = 'repeating-linear-gradient(45deg,var(--proto-line),var(--proto-line) 5px,var(--proto-line) 5px,var(--proto-line) 10px)';

/** The frame every inline media thumbnail sits in: rounded card corners, a hairline ring, and the
 *  striped placeholder until `url` resolves. */
export function thumbStageStyle(url: string | null, width: CSSProperties['width'], height: CSSProperties['height']): CSSProperties {
  return {
    position: 'relative', width, height, borderRadius: 'var(--r-card)',
    boxShadow: 'var(--shadow-card-subtle), 0 0 0 1px var(--proto-line-2)',
    background: url ? 'var(--media-stage-bg)' : stageFallback, boxSizing: 'border-box', flex: 'none',
    overflow: 'hidden', cursor: 'pointer',
  };
}
