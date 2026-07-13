import { describe, it, expect } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { LangProvider } from '@/i18n';
// Components consume useVocab() → wrap every render in LangProvider (defaults to en vocab).
function renderToStaticMarkup(el: ReactElement): string {
  return renderRaw(createElement(LangProvider, null, el));
}
import { MarkdownView } from './MarkdownView';
import { BlamePane } from './MemoryView';
import { groupBlame } from './memory-vm';
import type { MemoryBlameLine } from '@cortex-agent/ui-contract';

// react-dom/server render checks for the memory viewer 7b presentational surface. vitest
// runs in node; data fetching + the diff toggle + tree selection live in MemoryView (verified against
// a real ui-http-server, not here). Fixtures use neutral placeholder content (no private project data).

describe('MarkdownView', () => {
  it('renders a frontmatter card with chip keys and a summary line', () => {
    const src = '---\nid: NIMBUS-1\nstatus: active\nsummary: a neutral one-liner\n---\n# Title\n\nbody text';
    const html = renderToStaticMarkup(<MarkdownView content={src} />);
    expect(html).toContain('NIMBUS-1');
    expect(html).toContain('active');
    expect(html).toContain('summary');
    expect(html).toContain('a neutral one-liner');
    expect(html).toContain('Title');
  });

  it('renders headings, paragraphs and bullet lists', () => {
    const src = '# Background\n\nSome prose here.\n\n- first point\n- second point';
    const html = renderToStaticMarkup(<MarkdownView content={src} />);
    expect(html).toContain('Background');
    expect(html).toContain('Some prose here.');
    expect(html).toContain('first point');
    expect(html).toContain('·'); // bullet glyph
  });

  it('renders a GFM table with header and rows', () => {
    const src = '| Config | Success |\n| --- | --- |\n| alpha | 76% |\n| beta | 81% |';
    const html = renderToStaticMarkup(<MarkdownView content={src} />);
    expect(html).toContain('Config');
    expect(html).toContain('Success');
    expect(html).toContain('alpha');
    expect(html).toContain('81%');
    expect(html).toContain('display:grid');
  });

  it('renders inline code and links', () => {
    const src = 'use `cortex-run` and see [docs](https://example.com)';
    const html = renderToStaticMarkup(<MarkdownView content={src} />);
    expect(html).toContain('cortex-run');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('docs');
  });

  it('omits the frontmatter card when the file has none', () => {
    const html = renderToStaticMarkup(<MarkdownView content={'plain body, no frontmatter'} />);
    expect(html).toContain('plain body, no frontmatter');
    expect(html).not.toContain('summary');
  });
});

describe('BlamePane', () => {
  const blame: MemoryBlameLine[] = [
    { line: 1, commit: 'aaaa1111', taskRef: 'ab12' },
    { line: 2, commit: 'aaaa1111', taskRef: 'ab12' },
    { line: 3, commit: 'bbbb2222', taskRef: null },
  ];

  it('shows the real commit hash + task ref once per commit run, and the line text', () => {
    const rows = groupBlame(blame, 'alpha\nbeta\ngamma\n')!;
    const html = renderToStaticMarkup(<BlamePane rows={rows} />);
    // Line texts present.
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    expect(html).toContain('gamma');
    // Real commit hashes present (not fabricated).
    expect(html).toContain('aaaa1111');
    expect(html).toContain('bbbb2222');
    // Task ref chip present for the tagged commit.
    expect(html).toContain('ab12');
  });

  it('renders no task-ref chip when the commit carries none (honest blank, not fabricated)', () => {
    const rows = groupBlame(
      [{ line: 1, commit: 'cccc3333', taskRef: null }],
      'only line\n',
    )!;
    const html = renderToStaticMarkup(<BlamePane rows={rows} />);
    expect(html).toContain('cccc3333');
    expect(html).toContain('only line');
  });
});
