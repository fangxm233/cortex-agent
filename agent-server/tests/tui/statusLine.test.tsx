// input:  src/tui/components/StatusLine.js
// output: StatusLine tests — bottom bar: "? for shortcuts" + right-aligned project/queued/notif,
//         full shortcuts overlay on demand, abnormal connection status only
// pos:    Verifies the header-removal redesign (project/queue/notif moved to the bottom line)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusLine } from '../../src/tui/components/StatusLine.js';

test('StatusLine: connected shows the "? for shortcuts" hint, no connection dot/text', () => {
  const instance = render(React.createElement(StatusLine, {
    connectionState: 'connected',
    projectId: 'cortex',
  }));
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /\? for shortcuts/);
  assert.doesNotMatch(frame, /Connected/i, 'no "Connected" text when connected normally');
  assert.doesNotMatch(frame, /●/, 'no status dot when connected normally');
  instance.unmount();
  instance.cleanup();
});

test('StatusLine: shows project, queued and notification counts on the right', () => {
  const instance = render(React.createElement(StatusLine, {
    connectionState: 'connected',
    projectId: 'myproj',
    queuedCount: 2,
    notificationCount: 3,
  }));
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /myproj/);
  assert.match(frame, /2/);
  assert.match(frame, /3/);
  instance.unmount();
  instance.cleanup();
});

test('StatusLine: shortcuts overlay replaces the hint with the full key list', () => {
  const instance = render(React.createElement(StatusLine, {
    connectionState: 'connected',
    projectId: 'myproj',
    showShortcuts: true,
  }));
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /Dashboard/);
  assert.match(frame, /History/);
  assert.doesNotMatch(frame, /\? for shortcuts/, 'hint is hidden while the overlay is shown');
  instance.unmount();
  instance.cleanup();
});

test('StatusLine: abnormal connection state surfaces a status message', () => {
  const instance = render(React.createElement(StatusLine, {
    connectionState: 'reconnecting',
    projectId: 'myproj',
  }));
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /Reconnecting/i);
  instance.unmount();
  instance.cleanup();
});
