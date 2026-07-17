// input:  src/tui/render/rich-blocks.tsx
// output: Tests — actions block renders nothing; markdown/section text is styled
// pos:    Guards the "inert [Resume] [New] buttons removed" change + markdown wiring

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { RichBlocks } from '../../src/tui/render/rich-blocks.js';

test('actions block renders nothing (buttons replaced by slash commands)', () => {
  const blocks = [
    { type: 'section', text: 'Done' },
    { type: 'actions', elements: [{ text: 'Resume' }, { text: 'New' }, { text: 'New (quiet)' }] },
  ];
  const instance = render(React.createElement(RichBlocks, { blocks }));
  const frame = instance.lastFrame() ?? '';
  assert.ok(frame.includes('Done'), 'section text still renders');
  assert.equal(frame.includes('[Resume]'), false, 'no inert Resume button');
  assert.equal(frame.includes('New (quiet)'), false, 'no inert quiet button');
  instance.unmount();
  instance.cleanup();
});

test('markdown/section text is rendered through InlineMarkdown (markers stripped)', () => {
  const blocks = [{ type: 'markdown', text: 'see **bold** and `code`' }];
  const instance = render(React.createElement(RichBlocks, { blocks }));
  const frame = instance.lastFrame() ?? '';
  assert.equal(frame.includes('**'), false, 'bold markers stripped');
  assert.equal(frame.includes('`'), false, 'code backticks stripped');
  assert.ok(frame.includes('bold') && frame.includes('code'));
  instance.unmount();
  instance.cleanup();
});
