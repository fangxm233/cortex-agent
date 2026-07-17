// input:  src/tui/hooks/useKeybindings.js
// output: Keybinding tests — verify handler invocation via ink useInput
// pos:    Verifies Ctrl+C, Ctrl+L, arrow key handlers via stdin simulation

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useKeybindings } from '../../src/tui/hooks/useKeybindings.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Test component ──

function TestApp({ onEvent }: { onEvent: (name: string) => void }) {
  useKeybindings({
    onSubmit: () => onEvent('submit'),
    onCancel: () => onEvent('cancel'),
    onScrollUp: (page?: boolean) => onEvent(page ? 'pageUp' : 'scrollUp'),
    onScrollDown: (page?: boolean) => onEvent(page ? 'pageDown' : 'scrollDown'),
    onClearView: () => onEvent('clearView'),
    onExit: () => onEvent('exit'),
  });
  return React.createElement(Text, null, 'test app');
}

test('useKeybindings calls onClearView on Ctrl+L', async (t) => {
  const events: string[] = [];

  const app = React.createElement(TestApp, { onEvent: (name: string) => events.push(name) });
  const instance = render(app);

  // Wait for React effects to mount
  await delay(200);

  // Ctrl+L: raw byte \x0c (form feed) → parseKeypress gives { name: 'l', ctrl: true }
  instance.stdin.write('\x0c');

  await delay(200);

  assert.ok(events.includes('clearView'), `expected clearView in events: ${JSON.stringify(events)}`);

  instance.unmount();
  instance.cleanup();
});

test('useKeybindings calls onToggleSidePanel on Ctrl+D', async (t) => {
  const events: string[] = [];

  function TestApp2() {
    useKeybindings({
      onSubmit: () => {},
      onCancel: () => {},
      onScrollUp: () => {},
      onScrollDown: () => {},
      onClearView: () => {},
      onExit: () => {},
      onToggleSidePanel: () => events.push('toggleSidePanel'),
    });
    return React.createElement(Text, null, 'test');
  }

  const app = React.createElement(TestApp2);
  const instance = render(app);
  await delay(200);

  instance.stdin.write('\x04'); // Ctrl+D
  await delay(200);

  assert.ok(events.includes('toggleSidePanel'), `expected toggleSidePanel in events: ${JSON.stringify(events)}`);

  instance.unmount();
  instance.cleanup();
});

test('useKeybindings calls onToggleNotifications on Ctrl+N', async (t) => {
  const events: string[] = [];

  function TestApp3() {
    useKeybindings({
      onSubmit: () => {},
      onCancel: () => {},
      onScrollUp: () => {},
      onScrollDown: () => {},
      onClearView: () => {},
      onExit: () => {},
      onToggleNotifications: () => events.push('toggleNotifications'),
    });
    return React.createElement(Text, null, 'test');
  }

  const app = React.createElement(TestApp3);
  const instance = render(app);
  await delay(200);

  instance.stdin.write('\x0e'); // Ctrl+N
  await delay(200);

  assert.ok(events.includes('toggleNotifications'), `expected toggleNotifications in events: ${JSON.stringify(events)}`);

  instance.unmount();
  instance.cleanup();
});

test('useKeybindings calls onToggleProjectSwitcher on Ctrl+P', async (t) => {
  const events: string[] = [];

  function TestApp4() {
    useKeybindings({
      onSubmit: () => {},
      onCancel: () => {},
      onScrollUp: () => {},
      onScrollDown: () => {},
      onClearView: () => {},
      onExit: () => {},
      onToggleProjectSwitcher: () => events.push('toggleProjectSwitcher'),
    });
    return React.createElement(Text, null, 'test');
  }

  const app = React.createElement(TestApp4);
  const instance = render(app);
  await delay(200);

  instance.stdin.write('\x10'); // Ctrl+P
  await delay(200);

  assert.ok(events.includes('toggleProjectSwitcher'), `expected toggleProjectSwitcher in events: ${JSON.stringify(events)}`);

  instance.unmount();
  instance.cleanup();
});

test('useKeybindings calls onToggleMouse on Ctrl+T', async (t) => {
  const events: string[] = [];

  function TestAppMouse() {
    useKeybindings({
      onSubmit: () => {},
      onCancel: () => {},
      onScrollUp: () => {},
      onScrollDown: () => {},
      onClearView: () => {},
      onExit: () => {},
      onToggleMouse: () => events.push('toggleMouse'),
    });
    return React.createElement(Text, null, 'test');
  }

  const instance = render(React.createElement(TestAppMouse));
  await delay(200);

  instance.stdin.write('\x14'); // Ctrl+T
  await delay(200);

  assert.ok(events.includes('toggleMouse'), `expected toggleMouse in events: ${JSON.stringify(events)}`);

  instance.unmount();
  instance.cleanup();
});

test('useKeybindings calls onReconnect on R when allowReconnect is set', async (t) => {
  const events: string[] = [];

  function TestAppReconnect() {
    useKeybindings({
      onSubmit: () => {},
      onCancel: () => {},
      onScrollUp: () => {},
      onScrollDown: () => {},
      onClearView: () => {},
      onExit: () => {},
      onReconnect: () => events.push('reconnect'),
    }, true, { allowReconnect: true });
    return React.createElement(Text, null, 'test');
  }

  const instance = render(React.createElement(TestAppReconnect));
  await delay(200);

  instance.stdin.write('R');
  await delay(200);

  assert.ok(events.includes('reconnect'), `expected reconnect in events: ${JSON.stringify(events)}`);

  instance.unmount();
  instance.cleanup();
});

test('useKeybindings does NOT reconnect on R when allowReconnect is false', async (t) => {
  const events: string[] = [];

  function TestAppNoReconnect() {
    useKeybindings({
      onSubmit: () => {},
      onCancel: () => {},
      onScrollUp: () => {},
      onScrollDown: () => {},
      onClearView: () => {},
      onExit: () => {},
      onReconnect: () => events.push('reconnect'),
    }, true, { allowReconnect: false });
    return React.createElement(Text, null, 'test');
  }

  const instance = render(React.createElement(TestAppNoReconnect));
  await delay(200);

  instance.stdin.write('R');
  await delay(200);

  assert.equal(events.length, 0, `expected no reconnect, got ${JSON.stringify(events)}`);

  instance.unmount();
  instance.cleanup();
});

test('useKeybindings does NOT scroll when allowScroll is false', async (t) => {
  const events: string[] = [];

  function TestAppNoScroll() {
    useKeybindings({
      onSubmit: () => {},
      onCancel: () => {},
      onScrollUp: () => events.push('scrollUp'),
      onScrollDown: () => events.push('scrollDown'),
      onClearView: () => {},
      onExit: () => {},
    }, true, { allowScroll: false });
    return React.createElement(Text, null, 'test');
  }

  const instance = render(React.createElement(TestAppNoScroll));
  await delay(200);

  instance.stdin.write('\x1b[A'); // up arrow
  instance.stdin.write('\x1b[B'); // down arrow
  await delay(200);

  assert.equal(events.length, 0, `expected no scroll, got ${JSON.stringify(events)}`);

  instance.unmount();
  instance.cleanup();
});

test('useKeybindings does NOT cancel on Escape (Esc is owned by the active zone now)', async (t) => {
  const events: string[] = [];

  const app = React.createElement(TestApp, { onEvent: (name: string) => events.push(name) });
  const instance = render(app);

  // Wait for React effects to mount
  await delay(200);

  // Escape: raw byte \x1b → parseKeypress gives { name: 'escape' }
  instance.stdin.write('\x1b');

  await delay(200);

  // Escape no longer triggers a global turn-cancel — the slash palette / open panels /
  // resume picker handle it; Ctrl+C cancels turns.
  assert.equal(events.includes('cancel'), false, `expected no cancel from Escape: ${JSON.stringify(events)}`);

  instance.unmount();
  instance.cleanup();
});
