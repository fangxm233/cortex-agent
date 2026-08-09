// input:  Assistant Markdown containing valid, invalid, and untrusted math
// output: KaTeX rendering and safety regression coverage
// pos:    Component tests for assistant Markdown rendering
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';

describe('ChatMarkdown math', () => {
  it('renders all supported inline and display delimiters with KaTeX', () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={'Inline $x^2$ and \\(y^2\\).\n\n$$\\int_0^1 x\\,dx$$\n\n\\[z = mx + b\\]'}
        renderMath
      />,
    );

    expect(html.match(/class="katex"/g)).toHaveLength(4);
    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
  });

  it('keeps formulas literal unless math rendering is explicitly enabled', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={'Inline $x^2$'} />);

    expect(html).not.toContain('class="katex"');
    expect(html).toContain('$x^2$');
  });

  it('leaves formulas in code spans and fenced blocks untouched', () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown text={'Use `$x$` here.\n\n```tex\n$$y$$\n```'} renderMath />,
    );

    expect(html).not.toContain('class="katex"');
    expect(html).toContain('$x$</code>');
    expect(html).toContain('$$y$$');
  });

  it('does not crash on invalid or untrusted LaTeX', () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown text={'$\\notARealCommand$ and $\\href{javascript:alert(1)}{click}$ and $\\rule{1000000em}{1em}$'} renderMath />,
    );

    expect(html).toContain('class="katex"');
    expect(html).toContain('\\notARealCommand');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('width="1000000em"');
    expect(html).not.toContain('border-right-width:1000000em');
    expect(html).toContain('width="50em"');
  });
});
