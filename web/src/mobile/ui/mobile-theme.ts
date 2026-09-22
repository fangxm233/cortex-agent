// The mesh ground plus the two glass fills, named for the mobile surface vocabulary.
//
// BLUR BUDGET — stricter here than on desktop. `glassFilter` may only be paired with `glass` on
// chrome that holds still: the bottom Tab bar, a bottom sheet's own sheet, and a full-screen
// overlay's own panel. Never a card, never a list row, never anything inside a scroller: blur is a
// per-pixel read of everything behind the element, so a blurred row in a long list re-reads the
// backdrop on every scroll frame and visibly stutters in an Android WebView. Content cards stay
// OPAQUE (`card`) for exactly that reason — they are the thing that repeats in a long scroll.
export const MC = {
  backdrop: 'var(--app-backdrop)',
  /** Chrome pane fill. Only valid together with `glassFilter` — see the blur budget above. */
  glass: 'var(--glass-1)',
  /** Raised translucent fill with NO filter of its own; composites over whatever is behind it. */
  glassRaised: 'var(--glass-2)',
  glassFilter: 'var(--glass-filter)',
  canvas: 'var(--m-canvas)',
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
