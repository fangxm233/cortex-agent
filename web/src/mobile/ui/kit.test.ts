import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  shouldFlingClose,
  composerLineCount,
  composerCharCount,
  composerCountLabel,
  ComposerFullscreen,
  MComposer,
} from './kit';

// MBottomSheet drag-to-dismiss threshold (the grab handle is a live drag target): a released drag
// flings the sheet closed past ~28% of its height, or on a fast downward flick regardless of distance.
describe('shouldFlingClose', () => {
  const H = 300; // 28% ≈ 84px

  it('snaps back for a small, slow drag', () => {
    expect(shouldFlingClose(40, H, 0)).toBe(false);
    expect(shouldFlingClose(83, H, 0.1)).toBe(false);
  });

  it('closes once dragged past ~28% of the sheet height', () => {
    expect(shouldFlingClose(85, H, 0)).toBe(true);
    expect(shouldFlingClose(200, H, 0)).toBe(true);
  });

  it('closes on a fast downward flick even when the distance is short', () => {
    expect(shouldFlingClose(20, H, 0.9)).toBe(true);
  });

  it('does not close on a gentle flick below the velocity threshold', () => {
    expect(shouldFlingClose(20, H, 0.4)).toBe(false);
  });
});

// ── §2 composer · multi-line growth + full-screen editor (scheme-mobile.dc.html 2a/2b) ──────────────
describe('composerLineCount', () => {
  it('counts an empty field as one line', () => {
    expect(composerLineCount('')).toBe(1);
  });
  it('counts a single line', () => {
    expect(composerLineCount('hello world')).toBe(1);
  });
  it('counts one line per newline-separated row', () => {
    expect(composerLineCount('a\nb')).toBe(2);
    expect(composerLineCount('a\nb\nc\n')).toBe(4); // trailing newline opens a fresh row
  });
});

describe('composerCharCount', () => {
  it('counts code points (empty → 0)', () => {
    expect(composerCharCount('')).toBe(0);
    expect(composerCharCount('héllo')).toBe(5);
  });
  it('counts newlines as characters', () => {
    expect(composerCharCount('a\nb')).toBe(3);
  });
});

describe('composerCountLabel', () => {
  it('formats the 2b footer counter "N 行 · M 字"', () => {
    expect(composerCountLabel('a\nb', '行', '字')).toBe('2 行 · 3 字');
    expect(composerCountLabel('hi', 'lines', 'chars')).toBe('1 lines · 2 chars');
  });
});

describe('2b ComposerFullscreen', () => {
  const base = {
    value: 'line one\nline two',
    placeholder: '输入消息，/ 调用命令',
    onChange: () => {},
    onSend: () => {},
    sendEnabled: true,
    onCollapse: () => {},
    onPlus: () => {},
    lineUnit: '行',
    charUnit: '字',
  };
  it('renders the expanded field: textarea, collapse button, ＋ / slash tools, counter, and Send', () => {
    const html = renderToStaticMarkup(createElement(ComposerFullscreen, base));
    expect(html).toContain('<textarea');
    expect(html).toContain('line one'); // textarea keeps the drafted value
    expect(html).toContain('aria-label="Collapse"');
    expect(html).toContain('＋'); // attach tool in the bottom tool row
    expect(html).toContain('aria-label="Slash command"');
    expect(html).toContain('2 行 · 17 字'); // 2 lines · 17 chars
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain('aria-label="Stop"');
  });
  it('swaps Send for Stop while the session is running', () => {
    const html = renderToStaticMarkup(createElement(ComposerFullscreen, { ...base, running: true, onStop: () => {} }));
    expect(html).toContain('aria-label="Stop"');
    expect(html).not.toContain('aria-label="Send"');
  });
});

describe('2a MComposer multi-line growth', () => {
  it('renders a growable textarea (not a single-line input)', () => {
    const html = renderToStaticMarkup(
      createElement(MComposer, { placeholder: 'ph', value: '', onChange: () => {}, onSend: () => {} }),
    );
    expect(html).toContain('<textarea');
  });
  it('reveals the Expand affordance once the draft spans multiple lines', () => {
    const single = renderToStaticMarkup(
      createElement(MComposer, { placeholder: 'ph', value: 'one line', onChange: () => {}, onSend: () => {} }),
    );
    expect(single).not.toContain('aria-label="Expand"');
    const multi = renderToStaticMarkup(
      createElement(MComposer, { placeholder: 'ph', value: 'l1\nl2\nl3', onChange: () => {}, onSend: () => {} }),
    );
    expect(multi).toContain('aria-label="Expand"');
  });
});
