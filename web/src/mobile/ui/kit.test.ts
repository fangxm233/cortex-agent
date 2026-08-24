// input:  sheet markup, drag metrics, and composer text
// output: viewport, dismiss, and Unicode-safe count assertions
// pos:    Mobile UI-kit layout and logic tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  composerCharCount,
  composerLineCount,
  MBottomSheet,
  shouldFlingClose,
} from './kit';

describe('MBottomSheet viewport containment', () => {
  it('caps the sheet height and scrolls overflowing content', () => {
    const html = renderToStaticMarkup(
      createElement(MBottomSheet, { onClose: () => {} }, createElement('div', null, 'rows')),
    );

    expect(html).toContain('max-height:calc(100% - max(12px, env(safe-area-inset-top)))');
    expect(html).toContain('data-mobile-sheet-scroll="true"');
    expect(html).toContain('overflow-y:auto');
    expect(html).toContain('touch-action:pan-y');
  });
});

describe('shouldFlingClose', () => {
  it('closes after crossing the distance threshold', () => {
    expect(shouldFlingClose(83, 300, 0.1)).toBe(false);
    expect(shouldFlingClose(85, 300, 0.1)).toBe(true);
  });

  it('closes on a fast downward flick regardless of distance', () => {
    expect(shouldFlingClose(20, 300, 0.9)).toBe(true);
  });

  it('keeps a short, slow drag open', () => {
    expect(shouldFlingClose(20, 300, 0.4)).toBe(false);
  });
});

describe('composer text metrics', () => {
  it('counts newline-separated rows, including a trailing empty row', () => {
    expect(composerLineCount('')).toBe(1);
    expect(composerLineCount('a\nb\n')).toBe(3);
  });

  it('counts Unicode code points and includes newlines', () => {
    expect(composerCharCount('A😀\n中')).toBe(4);
  });
});
