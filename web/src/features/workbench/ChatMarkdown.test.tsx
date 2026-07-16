import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMarkdown } from './ChatMarkdown';

// The hr block renders as a 1px horizontal line (`background:#EFF1F5`). These lock the mobile
// `dropTrailingHr` opt-in without changing the default desktop behavior.
const HR_LINE = 'background:#EFF1F5';

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
