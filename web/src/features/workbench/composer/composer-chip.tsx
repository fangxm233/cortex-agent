import type { CSSProperties } from 'react';

// The composer toolbar's setting chips — agent, model, the chosen browser, a draft's project. They
// are settings rather than status, so they are not the hairline capsule: a filled quiet chip with no
// outline, the UI face, and a small muted glyph in front. Hover or an open menu deepens the fill one
// step; nothing turns the accent.

export const QUIET_CHIP_GLYPH = 'var(--proto-muted)';

export function quietChipStyle(lit: boolean): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, minWidth: 0, padding: '0 10px',
    boxSizing: 'border-box', border: 0, borderRadius: 'var(--r-chip)',
    background: lit ? 'var(--proto-line)' : 'var(--proto-line-2)',
    color: 'var(--proto-ink-2)', font: '400 12.5px var(--font-ui)', cursor: 'pointer',
  };
}

/** Which agent the conversation runs in: a small window, the environment it is set up in. */
export function AgentGlyph(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={QUIET_CHIP_GLYPH} strokeWidth="1.6"
      aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="2.5" y="3" width="11" height="10" rx="2" />
      <path d="M2.5 6.5h11" />
    </svg>
  );
}

/** What runs the turn: the model chip's spark. */
export function ModelGlyph(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={QUIET_CHIP_GLYPH} strokeWidth="1.6"
      strokeLinecap="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3" />
    </svg>
  );
}

/** Where a draft will land: the project chip's folder. */
export function ProjectGlyph(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={QUIET_CHIP_GLYPH} strokeWidth="1.5"
      strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M2 12.5v-8A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.6h4.8A1.5 1.5 0 0 1 14 6.1v6.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5z" />
    </svg>
  );
}
