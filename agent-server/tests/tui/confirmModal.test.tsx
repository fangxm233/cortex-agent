// input:  src/tui/components/ConfirmModal.tsx
// output: Tests — confirm path (no reason), cancel path, reason-input path
// pos:    Verifies ConfirmModal keybinding and text input behavior

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { ConfirmModal } from '../../src/tui/components/ConfirmModal.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('ConfirmModal y key calls onConfirm', async () => {
  let confirmed = false;

  const app = React.createElement(ConfirmModal, {
    title: 'Confirm Action',
    body: 'Are you sure?',
    onConfirm: () => { confirmed = true; },
    onCancel: () => { throw new Error('onCancel should not be called'); },
  });

  const instance = render(app);
  await delay(100);

  instance.stdin.write('y');
  await delay(100);

  assert.equal(confirmed, true, 'y key calls onConfirm');

  instance.unmount();
  instance.cleanup();
});

test('ConfirmModal Enter key calls onConfirm', async () => {
  let confirmed = false;

  const app = React.createElement(ConfirmModal, {
    title: 'Confirm Action',
    body: 'Are you sure?',
    onConfirm: () => { confirmed = true; },
    onCancel: () => { throw new Error('onCancel should not be called'); },
  });

  const instance = render(app);
  await delay(100);

  instance.stdin.write('\r');
  await delay(100);

  assert.equal(confirmed, true, 'Enter key calls onConfirm');

  instance.unmount();
  instance.cleanup();
});

test('ConfirmModal n key calls onCancel', async () => {
  let cancelled = false;

  const app = React.createElement(ConfirmModal, {
    title: 'Confirm Action',
    body: 'Are you sure?',
    onConfirm: () => { throw new Error('onConfirm should not be called'); },
    onCancel: () => { cancelled = true; },
  });

  const instance = render(app);
  await delay(100);

  instance.stdin.write('n');
  await delay(100);

  assert.equal(cancelled, true, 'n key calls onCancel');

  instance.unmount();
  instance.cleanup();
});

test('ConfirmModal Escape calls onCancel', async () => {
  let cancelled = false;

  const app = React.createElement(ConfirmModal, {
    title: 'Confirm Action',
    body: 'Are you sure?',
    onConfirm: () => { throw new Error('onConfirm should not be called'); },
    onCancel: () => { cancelled = true; },
  });

  const instance = render(app);
  await delay(100);

  instance.stdin.write('\x1b');
  await delay(100);

  assert.equal(cancelled, true, 'Escape calls onCancel');

  instance.unmount();
  instance.cleanup();
});

test('ConfirmModal reason input calls onConfirm with text', async () => {
  let reason: string | undefined;

  const app = React.createElement(ConfirmModal, {
    title: 'Block User',
    body: 'Enter reason for blocking',
    onConfirm: (r?: string) => { reason = r; },
    onCancel: () => { throw new Error('onCancel should not be called'); },
    reasonInput: { label: 'Reason:', placeholder: 'Enter reason...' },
  });

  const instance = render(app);
  await delay(100);

  // Type a reason, then press Enter (separate writes so UncontrolledTextInput processes text first)
  instance.stdin.write('violates policy');
  await delay(200);
  instance.stdin.write('\r');
  await delay(200);

  assert.equal(reason, 'violates policy', 'onConfirm called with typed reason');

  instance.unmount();
  instance.cleanup();
});
