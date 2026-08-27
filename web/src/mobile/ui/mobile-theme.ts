// input:  Global mobile CSS custom properties
// output: Shared mobile palette references and monospace font stack
// pos:    Mobile presentation token boundary
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export const MC = {
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
