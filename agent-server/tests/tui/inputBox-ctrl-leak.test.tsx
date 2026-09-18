// input:  src/tui/components/InputBox.js
// output: Regression — Ctrl-modified keys must not leak a character into the input
// pos:    Guards the "Ctrl+D opens dashboard but leaves a stray 'd' in the input box" bug

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox } from '../../src/tui/components/InputBox.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('InputBox does not leak a char from a Ctrl combo (Ctrl+D)', async () => {
  const instance = render(
    React.createElement(InputBox, {
      onSubmit: () => {},
      awaitingResponse: false,
      focus: true,
    }),
  );
  await delay(120);

  instance.stdin.write('xyz');
  await delay(80);
  instance.stdin.write('\x04'); // Ctrl+D — handled globally; must not type into input
  await delay(120);

  const frame = instance.lastFrame() ?? '';
  assert.ok(frame.includes('xyz'), `typed text should remain — frame:\n${frame}`);
  assert.ok(
    !frame.includes('xyzd'),
    `Ctrl+D must not leak a 'd' into the input — frame:\n${frame}`,
  );

  instance.unmount();
  instance.cleanup();
});
