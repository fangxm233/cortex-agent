// input:  src/tui/render/inline-markdown.tsx
// output: Tests — markers are stripped (styling applied), plain text passes through, urls kept
// pos:    Regression for "wrong bold" — raw **markers** must NOT appear in rendered output

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InlineMarkdown } from '../../src/tui/render/inline-markdown.js';

test('bold markers are stripped from rendered output', () => {
  const instance = render(React.createElement(InlineMarkdown, { text: '**You:** hello' }));
  const frame = instance.lastFrame() ?? '';
  assert.equal(frame.includes('**'), false, 'asterisks must not render literally');
  assert.ok(frame.includes('You:'), 'bold text content is preserved');
  assert.ok(frame.includes('hello'), 'trailing text is preserved');
  instance.unmount();
  instance.cleanup();
});

test('inline code backticks are stripped', () => {
  const instance = render(React.createElement(InlineMarkdown, { text: 'id `abc-123` done' }));
  const frame = instance.lastFrame() ?? '';
  assert.equal(frame.includes('`'), false, 'backticks must not render literally');
  assert.ok(frame.includes('abc-123'), 'code content is preserved');
  instance.unmount();
  instance.cleanup();
});

test('link renders label and keeps the url', () => {
  const instance = render(React.createElement(InlineMarkdown, { text: 'see [docs](https://x.io)' }));
  const frame = instance.lastFrame() ?? '';
  assert.ok(frame.includes('docs'), 'link label preserved');
  assert.ok(frame.includes('https://x.io'), 'url preserved');
  assert.equal(frame.includes(']('), false, 'raw link syntax must not render');
  instance.unmount();
  instance.cleanup();
});

test('plain text passes through unchanged', () => {
  const instance = render(React.createElement(InlineMarkdown, { text: 'just plain words' }));
  const frame = instance.lastFrame() ?? '';
  assert.ok(frame.includes('just plain words'));
  instance.unmount();
  instance.cleanup();
});
