// input:  src/tui/components/InputBox.js (editing: paste, multi-line, slash-with-args)
// output: Tests — multi-char paste inserts literally, trailing-backslash+Enter makes a newline,
//         a multi-line value submits as one message, and a slash command with args forwards args
// pos:    Guards the paste / multi-line / slash-args input behaviours

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox } from '../../src/tui/components/InputBox.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function setup() {
  const commands: Array<[string, string]> = [];
  const submitted: string[] = [];
  const app = React.createElement(InputBox, {
    onSubmit: (txt: string) => submitted.push(txt),
    onCommand: (name: string, args: string) => commands.push([name, args]),
    awaitingResponse: false,
    focus: true,
  });
  const instance = render(app);
  return { instance, commands, submitted };
}

test('a multi-character paste inserts literally without submitting', async () => {
  const { instance, submitted } = setup();
  await delay(120);
  instance.stdin.write('hello world');
  await delay(120);
  assert.equal(submitted.length, 0, 'paste must not submit');
  assert.match(instance.lastFrame() ?? '', /hello world/, 'pasted text is in the buffer');
  instance.unmount();
  instance.cleanup();
});

test('trailing backslash + Enter inserts a newline instead of submitting', async () => {
  const { instance, submitted } = setup();
  await delay(120);
  instance.stdin.write('line1\\'); // type "line1\"
  await delay(120);
  instance.stdin.write('\r');       // Enter on a trailing backslash → newline
  await delay(120);
  assert.equal(submitted.length, 0, 'backslash+Enter must not submit');
  instance.stdin.write('line2');
  await delay(120);
  instance.stdin.write('\r');       // plain Enter submits the whole multi-line value
  await delay(120);
  assert.deepEqual(submitted, ['line1\nline2'], `expected a 2-line submit, got ${JSON.stringify(submitted)}`);
  instance.unmount();
  instance.cleanup();
});

test('a slash command with args forwards the args via onCommand', async () => {
  const { instance, commands, submitted } = setup();
  await delay(120);
  instance.stdin.write('/cost today');
  await delay(120);
  instance.stdin.write('\r');
  await delay(120);
  assert.deepEqual(commands, [['cost', 'today']], `expected /cost today → onCommand, got ${JSON.stringify(commands)}`);
  assert.equal(submitted.length, 0, 'a matched slash command must not also submit');
  instance.unmount();
  instance.cleanup();
});

const LEFT = '\x1B[D';
const BACKSPACE = '\x7f';
const FORWARD_DELETE = '\x1B[3~';

test('Backspace (\\x7f) deletes the character BEFORE the cursor', async () => {
  const { instance } = setup();
  await delay(120);
  instance.stdin.write('abc');       // value "abc", cursor at 3
  await delay(80);
  instance.stdin.write(LEFT);        // cursor → 2
  await delay(40);
  instance.stdin.write(LEFT);        // cursor → 1 (between a and b)
  await delay(40);
  instance.stdin.write(BACKSPACE);   // removes the char before cursor → 'a' → "bc"
  await delay(120);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /bc/, 'expected "bc" after backspace');
  assert.doesNotMatch(frame, /abc/, 'the "a" must be gone');
  instance.unmount();
  instance.cleanup();
});

test('forward Delete (\\x1b[3~) deletes the character AFTER the cursor', async () => {
  const { instance } = setup();
  await delay(120);
  instance.stdin.write('abc');         // value "abc", cursor at 3
  await delay(80);
  instance.stdin.write(LEFT);          // cursor → 2
  await delay(40);
  instance.stdin.write(LEFT);          // cursor → 1 (between a and b)
  await delay(40);
  instance.stdin.write(FORWARD_DELETE);// removes the char after cursor → 'b' → "ac"
  await delay(120);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /ac/, 'expected "ac" after forward delete');
  assert.doesNotMatch(frame, /abc/, 'the "b" must be gone');
  instance.unmount();
  instance.cleanup();
});
