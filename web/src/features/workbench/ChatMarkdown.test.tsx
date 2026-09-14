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

describe('ChatMarkdown tables', () => {
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const wideRow = (cols: number): string => {
    const row = (fill: string): string => `| ${Array.from({ length: cols }, () => fill).join(' | ')} |`;
    return `${row('h')}\n${row('---')}\n${row('v')}`;
  };

  it('stays inside the prose column unless the host opts in', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={table} />);

    expect(html).toContain('<table');
    expect(html).not.toContain('--chat-bleed-w');
  });

  it('breaks out of the column and stays centred when tables are widened', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={table} wideTables />);

    expect(html).toContain('width:var(--chat-bleed-w, 100%)');
    expect(html).toContain('margin-left:calc((100% - var(--chat-bleed-w, 100%)) / 2)');
    expect(html).toContain('margin:0 auto');
  });

  // The table takes its max-content width so it can outgrow the block and scroll, and stops at the
  // cap so it wraps instead of growing without end.
  it('grows to its content and stops at the host cap', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={table} wideTables />);

    expect(html).toContain('width:max-content');
    expect(html).toContain('max-width:max(var(--chat-table-max-w, 200%), 192px)');
  });

  // A boxed host (mobile bubble, decision card) cannot break out, so it wraps to its own width.
  it('caps a boxed table at its own box rather than twice it', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={table} />);

    expect(html).toContain('max-width:max(100%, 192px)');
  });

  // …but not past the point where the columns stop being legible: many columns scroll instead.
  it('lets the per-column floor lift the cap over the box on a many-column table', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={wideRow(7)} />);

    expect(html).toContain('max-width:max(100%, 672px)');
  });

  // Wrapping only works if cells may break; the old `nowrap` would have pinned the table open.
  it('lets cells wrap, including inside an unbreakable token', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={table} wideTables />);

    expect(html).not.toContain('white-space:nowrap');
    expect(html).toContain('overflow-wrap:anywhere');
  });
});
