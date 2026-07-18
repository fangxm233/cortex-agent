import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMarkdown } from './ChatMarkdown';

// The hr block renders as a 1px horizontal line (`background:var(--proto-line-2)`). These lock the mobile
// `dropTrailingHr` opt-in without changing the default desktop behavior.
const HR_LINE = 'background:var(--proto-line-2)';

describe('ChatMarkdown dropTrailingHr', () => {
  it('renders a trailing `---` as a horizontal rule by default (desktop unchanged)', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={'done\n\n---'} />);
    expect(html).toContain('done');
    expect(html).toContain(HR_LINE);
  });

  it('strips the trailing horizontal rule when dropTrailingHr is set', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={'done\n\n---'} dropTrailingHr />);
    expect(html).toContain('done');
    expect(html).not.toContain(HR_LINE);
  });

  it('keeps a horizontal rule that is NOT trailing', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={'intro\n\n---\n\nmore text'} dropTrailingHr />);
    expect(html).toContain('intro');
    expect(html).toContain('more text');
    expect(html).toContain(HR_LINE); // the mid-message divider survives
  });
});

describe('ChatMarkdown table horizontal overflow', () => {
  const TABLE = '| Col A | Col B | Col C |\n| --- | --- | --- |\n| one | two | three |';

  it('wraps the table in a horizontally scrollable, width-capped container', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={TABLE} />);
    // The wrapper never grows past its bubble; it scrolls horizontally instead of expanding the chat.
    expect(html).toContain('overflow-x:auto');
    expect(html).toContain('max-width:100%');
  });

  it('keeps cell content on one line so the table takes its natural width (no squish)', () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={TABLE} />);
    expect(html).toContain('white-space:nowrap');
  });
});
