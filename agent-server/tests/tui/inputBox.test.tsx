// input:  src/tui/components/InputBox.js
// output: InputBox tests — send when idle, blocked (text preserved) while awaiting response
// pos:    Verifies the "type but cannot send while waiting" requirement

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox } from '../../src/tui/components/InputBox.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('InputBox submits typed text when not awaiting', async (t) => {
  const submitted: string[] = [];
  const app = React.createElement(InputBox, {
    onSubmit: (txt: string) => submitted.push(txt),
    awaitingResponse: false,
    focus: true,
  });
  const instance = render(app);
  await delay(150);

  instance.stdin.write('hello');
  await delay(100);
  instance.stdin.write('\r'); // Enter
  await delay(150);

  assert.deepEqual(submitted, ['hello'], `expected one submit, got ${JSON.stringify(submitted)}`);

  instance.unmount();
  instance.cleanup();
});

test('InputBox recalls the previous message on Up arrow', async (t) => {
  const submitted: string[] = [];
  const app = React.createElement(InputBox, {
    onSubmit: (txt: string) => submitted.push(txt),
    awaitingResponse: false,
    focus: true,
  });
  const instance = render(app);
  await delay(150);

  instance.stdin.write('first message');
  await delay(60);
  instance.stdin.write('\r'); // submit → pushed to history, input cleared
  await delay(120);
  assert.deepEqual(submitted, ['first message']);
  assert.doesNotMatch(instance.lastFrame() ?? '', /first message/, 'input cleared after submit');

  instance.stdin.write('\x1b[A'); // Up arrow → recall
  await delay(120);
  assert.match(instance.lastFrame() ?? '', /first message/, 'Up arrow recalls the last message');

  instance.unmount();
  instance.cleanup();
});

test('InputBox "?" on empty input toggles shortcuts instead of typing', async (t) => {
  let toggles = 0;
  const app = React.createElement(InputBox, {
    onSubmit: () => {},
    onToggleShortcuts: () => { toggles += 1; },
    showShortcuts: false,
    awaitingResponse: false,
    focus: true,
  });
  const instance = render(app);
  await delay(150);

  instance.stdin.write('?');
  await delay(120);

  assert.equal(toggles, 1, 'pressing ? toggled the shortcuts overlay');
  // '?' must not leak into the message buffer (input still shows the placeholder).
  assert.match(instance.lastFrame() ?? '', /Type a message/);

  instance.unmount();
  instance.cleanup();
});

test('InputBox dismisses shortcuts on any key when shown', async (t) => {
  let dismissed = 0;
  const app = React.createElement(InputBox, {
    onSubmit: () => {},
    onDismissShortcuts: () => { dismissed += 1; },
    showShortcuts: true,
    awaitingResponse: false,
    focus: true,
  });
  const instance = render(app);
  await delay(150);

  instance.stdin.write('x'); // any key
  await delay(120);

  assert.equal(dismissed, 1, 'any key dismisses the shortcuts overlay');
  // The key that dismissed must not be inserted into the buffer.
  assert.doesNotMatch(instance.lastFrame() ?? '', /x/);

  instance.unmount();
  instance.cleanup();
});

test('InputBox renders the turn-status line tight above the input', async (t) => {
  const app = React.createElement(InputBox, {
    onSubmit: () => {},
    statusLine: '✅ Done · 3s · 1 turns · $0.2680',
    awaitingResponse: false,
    focus: true,
  });
  const instance = render(app);
  await delay(120);
  assert.match(instance.lastFrame() ?? '', /✅ Done · 3s · 1 turns · \$0\.2680/);
  instance.unmount();
  instance.cleanup();
});

test('InputBox ignores mouse-tracking escape residue (no leak into the buffer)', async (t) => {
  const submitted: string[] = [];
  const app = React.createElement(InputBox, {
    onSubmit: (txt: string) => submitted.push(txt),
    awaitingResponse: false,
    focus: true,
  });
  const instance = render(app);
  await delay(120);

  instance.stdin.write('[<64;30;10M'); // SGR wheel residue (ESC already stripped by Ink)
  await delay(100);
  // The residue must not appear in the input (placeholder still shown).
  assert.match(instance.lastFrame() ?? '', /Type a message/);
  assert.doesNotMatch(instance.lastFrame() ?? '', /64;30;10M/);

  instance.unmount();
  instance.cleanup();
});

test('InputBox does NOT submit while awaiting a response', async (t) => {
  const submitted: string[] = [];
  const app = React.createElement(InputBox, {
    onSubmit: (txt: string) => submitted.push(txt),
    awaitingResponse: true,
    focus: true,
  });
  const instance = render(app);
  await delay(150);

  instance.stdin.write('hello');
  await delay(100);
  instance.stdin.write('\r'); // Enter — should be ignored
  await delay(150);

  assert.equal(submitted.length, 0, `expected no submit while awaiting, got ${JSON.stringify(submitted)}`);
  // Text is preserved (still visible in the frame)
  assert.match(instance.lastFrame() ?? '', /hello/);

  instance.unmount();
  instance.cleanup();
});
