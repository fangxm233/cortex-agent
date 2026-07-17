// input:  src/tui/components/InputBox.js (slash palette)
// output: Tests — menu opens on '/', Enter runs a command, arrows select, Tab completes,
//         unknown '/word' falls back to onSubmit
// pos:    Guards the Claude-Code-style slash-command palette

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox } from '../../src/tui/components/InputBox.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

const DOWN = '\x1B[B';

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

test('typing "/" opens the command menu', async (t) => {
  const { instance } = setup();
  await delay(120);
  instance.stdin.write('/');
  await delay(120);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /\/new\b/, 'menu lists /new');
  assert.match(frame, /\/resume\b/, 'menu lists /resume');
  instance.unmount();
  instance.cleanup();
});

test('"/new" + Enter runs the command, not onSubmit', async (t) => {
  const { instance, commands, submitted } = setup();
  await delay(120);
  instance.stdin.write('/new');
  await delay(120);
  instance.stdin.write('\r');
  await delay(120);
  assert.deepEqual(commands, [['new', '']], `expected /new command, got ${JSON.stringify(commands)}`);
  assert.equal(submitted.length, 0, 'must not also submit as a message');
  instance.unmount();
  instance.cleanup();
});

test('arrow-down then Enter runs the second command', async (t) => {
  const { instance, commands } = setup();
  await delay(120);
  instance.stdin.write('/'); // menu shows all commands; [0]=new, [1]=newx
  await delay(120);
  instance.stdin.write(DOWN);
  await delay(80);
  instance.stdin.write('\r');
  await delay(120);
  assert.deepEqual(commands, [['newx', '']], `expected /newx via arrow, got ${JSON.stringify(commands)}`);
  instance.unmount();
  instance.cleanup();
});

test('Tab completes the highlighted command into the buffer', async (t) => {
  const { instance } = setup();
  await delay(120);
  instance.stdin.write('/re');
  await delay(120);
  instance.stdin.write('\t');
  await delay(120);
  assert.match(instance.lastFrame() ?? '', /\/resume /, 'buffer completed to "/resume "');
  instance.unmount();
  instance.cleanup();
});

test('unknown "/word" + Enter falls back to onSubmit', async (t) => {
  const { instance, commands, submitted } = setup();
  await delay(120);
  instance.stdin.write('/zzz');
  await delay(120);
  instance.stdin.write('\r');
  await delay(120);
  assert.equal(commands.length, 0, 'no command matched');
  assert.deepEqual(submitted, ['/zzz'], `expected fallback submit, got ${JSON.stringify(submitted)}`);
  instance.unmount();
  instance.cleanup();
});
