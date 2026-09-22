// input:  Shared CSS theme tokens
// output: MC, MONO
// pos:    Mobile palette and stable reading surface aliases
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

// BLUR BUDGET: only stationary chrome, a sheet, or a small open overlay samples
// the backdrop. Scrolling cards and controls use shared material fills without
// filters. Keep `card` opaque for reading/media and sticky text occlusion.
export const MC = {
  backdrop: 'var(--app-backdrop)',
  /** Chrome pane fill. Only valid together with `glassFilter` — see the blur budget above. */
  glass: 'var(--glass-1)',
  /** Raised translucent fill with NO filter of its own; composites over whatever is behind it. */
  glassRaised: 'var(--glass-2)',
  glassFilter: 'var(--glass-filter)',
  canvas: 'var(--m-canvas)',
  /** Stable reading/occlusion fill, not the default material for list cards. */
  card: 'var(--m-card)',
  ink: 'var(--m-ink)',
  sub: 'var(--m-sub)',
  body: 'var(--m-body)',
  muted: 'var(--m-muted)',
  faint: 'var(--m-faint)',
  hairline: 'var(--m-hairline)',
  divider: 'var(--m-divider)',
  cardBorder: 'var(--m-card-border)',
  run: 'var(--m-run)',
  runBg: 'var(--m-run-bg)',
  runBorder: 'var(--m-run-border)',
  amber: 'var(--m-amber)',
  amberInk: 'var(--m-amber-ink)',
  amberText: 'var(--m-amber-text)',
  amberBg: 'var(--m-amber-bg)',
  amberBorder: 'var(--m-amber-border)',
  amberCard: 'var(--m-amber-card)',
  done: 'var(--m-done)',
  doneBg: 'var(--m-done-bg)',
  fail: 'var(--m-fail)',
  failBg: 'var(--m-fail-bg)',
  failBorder: 'var(--m-fail-border)',
  gray: 'var(--m-gray)',
  grayInk: 'var(--m-gray-ink)',
  inkSolid: 'var(--ink-solid-bg)',
  inkSolidFg: 'var(--ink-solid-fg)',
  inkSolidFgDim: 'var(--ink-solid-fg-dim)',
} as const;

export const MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace";
