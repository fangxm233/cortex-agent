// input:  src/tui/components/MessageRow.tsx
// output: Tests — text+richBlocks renders once (no dup), streamed markdown is styled
// pos:    Regressions for the doubled sealed-status line and literal-markdown reply

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageRow } from '../../src/tui/components/MessageRow.js';
import type { RenderedMessage } from '../../src/tui/hooks/useTranscript.js';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('sealed-status message (text + section block with same text) renders the text once', () => {
  const msg: RenderedMessage = {
    messageId: 'm1',
    text: 'Done cortex-08ab39',
    richBlocks: [
      { type: 'section', text: 'Done cortex-08ab39' },
      { type: 'actions', elements: [{ text: 'Resume' }, { text: 'New' }] },
    ],
    queued: false,
    streams: new Map(),
  };
  const instance = render(React.createElement(MessageRow, { message: msg }));
  const frame = instance.lastFrame() ?? '';
  assert.equal(countOccurrences(frame, 'Done cortex-08ab39'), 1, 'status text must appear exactly once');
  // Action buttons are no longer rendered in the TUI (replaced by `/` slash commands).
  assert.equal(frame.includes('[Resume]'), false, 'inert action labels are not rendered');
  instance.unmount();
  instance.cleanup();
});

test('streamed reply with markdown is styled (markers stripped)', () => {
  const msg: RenderedMessage = {
    messageId: 'm2',
    text: '',
    queued: false,
    streams: new Map([['s1', { blocks: [{ kind: 'text' as const, text: 'hello **world** and `foo`' }] }]]),
  };
  const instance = render(React.createElement(MessageRow, { message: msg }));
  const frame = instance.lastFrame() ?? '';
  assert.equal(frame.includes('**'), false, 'bold markers stripped from streamed text');
  assert.equal(frame.includes('`'), false, 'code backticks stripped from streamed text');
  assert.ok(frame.includes('world'), 'bold content preserved');
  assert.ok(frame.includes('foo'), 'code content preserved');
  instance.unmount();
  instance.cleanup();
});

test('plain text message (no richBlocks) still renders its text', () => {
  const msg: RenderedMessage = {
    messageId: 'm3',
    text: 'just a plain reply',
    queued: false,
    streams: new Map(),
  };
  const instance = render(React.createElement(MessageRow, { message: msg }));
  const frame = instance.lastFrame() ?? '';
  assert.ok(frame.includes('just a plain reply'));
  instance.unmount();
  instance.cleanup();
});
