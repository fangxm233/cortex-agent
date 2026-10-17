import { describe, it, expect } from 'vitest';
import { splitFrontmatter, parseInline, parseBlocks, safeLinkHref } from './markdown';

describe('splitFrontmatter', () => {
  it('returns null frontmatter when the file has no leading fence', () => {
    const { frontmatter, body } = splitFrontmatter('# Title\n\nhello');
    expect(frontmatter).toBeNull();
    expect(body).toBe('# Title\n\nhello');
  });

  it('extracts key/value entries and the body after the closing fence', () => {
    const src = '---\nid: NIMBUS-1\ndate: 2026-07-04\nstatus: active\n---\n# Title\n\nbody line';
    const { frontmatter, body } = splitFrontmatter(src);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.entries).toEqual([
      { key: 'id', value: 'NIMBUS-1' },
      { key: 'date', value: '2026-07-04' },
      { key: 'status', value: 'active' },
    ]);
    expect(body).toBe('# Title\n\nbody line');
  });

  it('pulls a summary key out of the chip entries', () => {
    const src = '---\nid: A\nsummary: a short line\n---\ntext';
    const { frontmatter } = splitFrontmatter(src);
    expect(frontmatter!.summary).toBe('a short line');
    expect(frontmatter!.entries.map((e) => e.key)).toEqual(['id']);
  });

  it('handles CRLF and quoted values', () => {
    const src = '---\r\nid: "quoted"\r\n---\r\nbody';
    const { frontmatter, body } = splitFrontmatter(src);
    expect(frontmatter!.entries).toEqual([{ key: 'id', value: 'quoted' }]);
    expect(body).toBe('body');
  });

  it('treats an unterminated fence as no frontmatter', () => {
    const src = '---\nid: A\nno closing fence';
    const { frontmatter, body } = splitFrontmatter(src);
    expect(frontmatter).toBeNull();
    expect(body).toBe(src);
  });
});

describe('parseInline', () => {
  it('returns a single text node for plain text', () => {
    expect(parseInline('just text')).toEqual([{ type: 'text', text: 'just text' }]);
  });

  it('parses bold, italic, code and links as spans', () => {
    expect(parseInline('a **b** c')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'bold', text: 'b' },
      { type: 'text', text: ' c' },
    ]);
    expect(parseInline('use `code` here')).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ' here' },
    ]);
    expect(parseInline('see [docs](https://x.y)')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'docs', href: 'https://x.y' },
    ]);
    expect(parseInline('_em_')).toEqual([{ type: 'italic', text: 'em' }]);
  });

  it('parses inline dollar and parenthesized math only when enabled', () => {
    expect(parseInline('$x_i * y_i$').some((node) => node.type === 'math')).toBe(false);
    expect(parseInline('Energy $x_i * y_i$ and \\(z^2\\).', { math: true })).toEqual([
      { type: 'text', text: 'Energy ' },
      { type: 'math', text: 'x_i * y_i' },
      { type: 'text', text: ' and ' },
      { type: 'math', text: 'z^2' },
      { type: 'text', text: '.' },
    ]);
  });

  it('keeps code, currency, escaped dollars, and unclosed delimiters literal', () => {
    expect(parseInline('use `$x$` here', { math: true })).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'code', text: '$x$' },
      { type: 'text', text: ' here' },
    ]);
    expect(parseInline('use `` `$x$` `` here', { math: true }).some((node) => node.type === 'math')).toBe(false);
    expect(parseInline('costs $5 and $10', { math: true })).toEqual([
      { type: 'text', text: 'costs $5 and $10' },
    ]);
    expect(parseInline('I paid $5 for x, where $x=2$.', { math: true })).toEqual([
      { type: 'text', text: 'I paid $5 for x, where ' },
      { type: 'math', text: 'x=2' },
      { type: 'text', text: '.' },
    ]);
    expect(parseInline('escaped \\$x$ and open $y', { math: true })).toEqual([
      { type: 'text', text: 'escaped \\$x$ and open $y' },
    ]);
  });
});

describe('parseInline images', () => {
  it('parses an image and does not fall through to the link rule', () => {
    expect(parseInline('![plot](assets/p.png)')).toEqual([
      { type: 'image', alt: 'plot', src: 'assets/p.png' },
    ]);
  });

  it('keeps a plain link a link when it follows an image', () => {
    expect(parseInline('![a](x.png) and [b](y)')).toEqual([
      { type: 'image', alt: 'a', src: 'x.png' },
      { type: 'text', text: ' and ' },
      { type: 'link', text: 'b', href: 'y' },
    ]);
  });

  it('accepts an empty alt', () => {
    expect(parseInline('![](a.png)')).toEqual([{ type: 'image', alt: '', src: 'a.png' }]);
  });
});

describe('parseBlocks', () => {
  it('parses headings with levels', () => {
    const blocks = parseBlocks('# H1\n## H2');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 2 });
    expect((blocks[0] as any).inline).toEqual([{ type: 'text', text: 'H1' }]);
  });

  it('joins consecutive non-blank lines into a paragraph', () => {
    const blocks = parseBlocks('line one\nline two\n\nnext para');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'paragraph' });
    expect((blocks[0] as any).inline).toEqual([{ type: 'text', text: 'line one line two' }]);
  });

  it('parses unordered and ordered lists', () => {
    const ul = parseBlocks('- a\n- b');
    expect(ul[0]).toMatchObject({ type: 'list', ordered: false });
    expect((ul[0] as any).items).toHaveLength(2);
    const ol = parseBlocks('1. first\n2. second');
    expect(ol[0]).toMatchObject({ type: 'list', ordered: true });
  });

  it('parses a GFM pipe table with a separator row', () => {
    const src = '| Config | Success |\n| --- | --- |\n| a | 76% |\n| b | 81% |';
    const blocks = parseBlocks(src);
    expect(blocks).toHaveLength(1);
    const t = blocks[0] as any;
    expect(t.type).toBe('table');
    expect(t.header.map((c: any[]) => c[0].text)).toEqual(['Config', 'Success']);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0][1][0].text).toBe('76%');
  });

  it('keeps an escaped pipe inside its table cell', () => {
    const src = '| a | b |\n| --- | --- |\n| x | kt\\|v_t\\| holds |\n| y | ends \\| |';
    const t = parseBlocks(src)[0] as any;
    expect(t.rows[0]).toHaveLength(2);
    expect(t.rows[0][1][0].text).toBe('kt|v_t| holds');
    expect(t.rows[1].map((c: any[]) => c[0].text)).toEqual(['y', 'ends |']);
  });

  it('parses a fenced code block and keeps its text verbatim', () => {
    const src = '```ts\nconst x = 1;\n```';
    const blocks = parseBlocks(src);
    expect(blocks[0]).toMatchObject({ type: 'code', lang: 'ts', text: 'const x = 1;' });
  });

  it('parses dollar and bracket display math only when enabled', () => {
    expect(parseBlocks('$$x^2$$')).toEqual([
      { type: 'paragraph', inline: [{ type: 'text', text: '$$x^2$$' }] },
    ]);
    expect(parseBlocks('$$\n\\int_0^1 x\\,dx\n$$\n\n\\[y = mx + b\\]', { math: true })).toEqual([
      { type: 'math', text: '\\int_0^1 x\\,dx' },
      { type: 'math', text: 'y = mx + b' },
    ]);
  });

  it('does not parse display delimiters inside code or before they close', () => {
    for (const source of [
      '```tex\n$$x^2$$\n```',
      '````c++ title="sample"\n$$x^2$$\n````',
      '~~~tex\n$$x^2$$\n~~~',
    ]) {
      expect(parseBlocks(source, { math: true })[0]).toMatchObject({ type: 'code', text: '$$x^2$$' });
      expect(parseBlocks(source, { math: true }).some((block) => block.type === 'math')).toBe(false);
    }
    for (const prefix of ['$$', '$$x', '$$x$']) {
      expect(parseBlocks(prefix, { math: true }).some((block) => block.type === 'math')).toBe(false);
    }
    expect(parseBlocks('$$x$$ trailing\nplain\nend$$', { math: true }).some((block) => block.type === 'math')).toBe(false);
  });

  it('parses a blockquote and a horizontal rule', () => {
    const blocks = parseBlocks('> quoted\n\n---');
    expect(blocks[0]).toMatchObject({ type: 'blockquote' });
    expect(blocks[1]).toMatchObject({ type: 'hr' });
  });
});

describe('link scheme filter', () => {
  it.each([
    'https://example.org/a?b=c#d',
    'http://example.org',
    'HTTPS://EXAMPLE.ORG',
    'mailto:someone@example.org',
    './experiments/EXP-012.md',
    'experiments/EXP-012.md',
    '../notes.md',
    '/abs/path.md',
    '#section',
    '?tab=1',
    '//example.org/x',
    'docs/a:b.md',
  ])('keeps %s', (href) => {
    expect(safeLinkHref(href)).toBe(href);
    expect(parseInline(`[x](${href})`)).toEqual([{ type: 'link', text: 'x', href }]);
  });

  it.each([
    'javascript:alert%281%29',
    'JaVaScRiPt:alert%281%29',
    ' javascript:alert%281%29',
    'java\tscript:alert%281%29',
    'java\nscript:alert%281%29',
    'java\u0000script:alert%281%29',
    '\u0001javascript:alert%281%29',
    '&#106;avascript:alert%281%29',
    '&#x6A;avascript:alert%281%29',
    '&#106avascript:alert%281%29',
    'jav&#x09;ascript:alert%281%29',
    'javascript&colon;alert%281%29',
    'javascript&#58;alert%281%29',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'DATA:text/html,<script>alert%281%29</script>',
    'vbscript:msgbox%281%29',
    'file:///etc/passwd',
    'blob:https://example.org/uuid',
  ])('renders %j as plain text', (href) => {
    expect(safeLinkHref(href)).toBeNull();
    expect(parseInline(`see [click me](${href}) now`)).toEqual([{ type: 'text', text: 'see click me now' }]);
  });
});

describe('link targets with parentheses', () => {
  it('keeps balanced parentheses inside a link target', () => {
    const href = 'https://en.wikipedia.org/wiki/Rust_(programming_language)';
    expect(parseInline(`see [Rust](${href}) for more`)).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'Rust', href },
      { type: 'text', text: ' for more' },
    ]);
  });

  it('keeps two levels of nesting and several pairs', () => {
    expect(parseInline('[a](https://x.org/A_(B_(C)))')).toEqual([{ type: 'link', text: 'a', href: 'https://x.org/A_(B_(C))' }]);
    expect(parseInline('[a](https://x.org/(1)_(2))')).toEqual([{ type: 'link', text: 'a', href: 'https://x.org/(1)_(2)' }]);
  });

  it('still ends the target at the first unmatched parenthesis', () => {
    expect(parseInline('[a](https://x.org/b) (note)')).toEqual([
      { type: 'link', text: 'a', href: 'https://x.org/b' },
      { type: 'text', text: ' (note)' },
    ]);
    expect(parseInline('([a](https://x.org/b))')).toEqual([
      { type: 'text', text: '(' },
      { type: 'link', text: 'a', href: 'https://x.org/b' },
      { type: 'text', text: ')' },
    ]);
  });

  it('keeps balanced parentheses in an image source', () => {
    expect(parseInline('![plot](figs/run_(3).png)')).toEqual([{ type: 'image', alt: 'plot', src: 'figs/run_(3).png' }]);
  });

  it('applies the scheme filter to the whole target', () => {
    expect(parseInline('[x](javascript:alert(document.cookie)) after')).toEqual([{ type: 'text', text: 'x after' }]);
    expect(parseInline('[x](JaVaScRiPt:void(0))')).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('leaves code spans that contain links untouched', () => {
    expect(parseInline('`[a](b(c))`')).toEqual([{ type: 'code', text: '[a](b(c))' }]);
  });
});
