import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
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

describe('ChatMarkdown code blocks', () => {
  it('copies the raw block text from its copy button', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<ChatMarkdown text={'Run:\n\n```sh\necho "$HOME"\nls -la\n```'} />);
    });

    const button = renderer.root.findByProps({ 'aria-label': 'Copy' });
    act(() => button.props.onClick());

    expect(writeText).toHaveBeenCalledWith('echo "$HOME"\nls -la');
    vi.unstubAllGlobals();
  });
});
