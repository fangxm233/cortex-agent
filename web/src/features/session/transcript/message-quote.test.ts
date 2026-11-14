import { describe, expect, it } from 'vitest';
import { quoteMessage, quotePreview, splitQuote } from './message-quote';

describe('quoteMessage', () => {
  it('prefixes the text with the quote as a Markdown blockquote', () => {
    expect(quoteMessage('line one\n\nline two', 'why?')).toBe('> line one\n>\n> line two\n\nwhy?');
  });

  it('leaves the text alone when there is nothing to quote', () => {
    expect(quoteMessage('  \n ', 'why?')).toBe('why?');
  });
});

describe('splitQuote', () => {
  it('round-trips a quoted message', () => {
    expect(splitQuote(quoteMessage('a\n\nb', 'reply\nmore'))).toEqual({ quote: 'a\n\nb', body: 'reply\nmore' });
  });

  it('finds no quote in plain text or a quote marker after the first line', () => {
    expect(splitQuote('hello\n> not a lead quote')).toEqual({ quote: null, body: 'hello\n> not a lead quote' });
  });

  it('keeps a quote with no reply under it', () => {
    expect(splitQuote('> only this')).toEqual({ quote: 'only this', body: '' });
  });
});

describe('quotePreview', () => {
  it('runs the quote together on one line without Markdown markers', () => {
    expect(quotePreview('  **first**\n\n- `second`  \n')).toBe('first - second');
  });
});
