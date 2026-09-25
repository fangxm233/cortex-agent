// input:  settings atoms, desktop platform typography tokens
// output: platform field, hint and block styles
// pos:    Local style seam for shared platform editors
// >>> Once updated, update this header and parent AGENTS.md <<<

import type { CSSProperties } from 'react';
import { S_CONTROL_DISABLED_STYLE, S_CONTROL_STYLE } from './settings-ui';

/**
 * The kit control, minus its `outline: none`. Every other settings panel is desktop-only and
 * relies on the kit's JS focus rings, but this panel is also the mobile platform screen, so its
 * fields keep the native outline for the stylesheet's `:focus-visible` rule to draw.
 */
export function psFieldStyle(disabled: boolean): CSSProperties {
  return { ...(disabled ? S_CONTROL_DISABLED_STYLE : S_CONTROL_STYLE), outline: undefined };
}

/** A stacked block of a platform card, hairline-separated from the block above it. */
export const PS_BLOCK_STYLE: CSSProperties = {
  padding: '14px 16px',
  borderTop: '1px solid var(--proto-line-2)',
};

/** Advisory copy that is not a notice: guidance sitting under a control or a heading. */
export const PS_HINT_STYLE: CSSProperties = {
  margin: '10px 0 0',
  fontSize: 'var(--settings-platform-hint-size, 11.5px)',
  lineHeight: 1.6,
  color: 'var(--proto-muted-2)',
  overflowWrap: 'anywhere',
};
