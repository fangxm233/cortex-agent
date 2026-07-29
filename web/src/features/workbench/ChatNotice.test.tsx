// input:  ChatNotice levels and caller-provided text
// output: semantic notice roles and level markers
// pos:    Shared chat-notice behavior contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatNotice, noticeTone } from './ChatNotice';

describe('ChatNotice', () => {
  it.each([
    ['info', 'status'],
    ['warning', 'alert'],
    ['error', 'alert'],
  ] as const)('maps %s notices to the expected semantic role', (level, role) => {
    const text = `notice:${level}`;
    const html = renderToStaticMarkup(<ChatNotice level={level} text={text} />);

    expect(html).toContain(`data-chat-notice="${level}"`);
    expect(html).toContain(`role="${role}"`);
    expect(html).toContain(text);
  });

  it('exposes the shared level tones for card badges (one token set per level)', () => {
    const levels = ['info', 'warning', 'error'] as const;
    const fgs = levels.map((level) => noticeTone(level).fg);
    for (const fg of fgs) expect(fg).toMatch(/^var\(--proto-/);
    expect(new Set(fgs).size).toBe(3);
  });
});
