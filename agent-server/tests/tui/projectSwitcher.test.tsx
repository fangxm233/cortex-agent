// input:  src/tui/components/ProjectSwitcher.jsx
// output: Tests — selection emits onSelect callback, escape closes, navigation works
// pos:    Verifies ProjectSwitcher keybinding behavior

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { ProjectSwitcher } from '../../src/tui/components/ProjectSwitcher.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('ProjectSwitcher renders projects and calls onSelect on Enter', async (t) => {
  const projects = [
    { id: 'general', kind: 'general' },
    { id: 'cortex-self', kind: 'research', hasMission: true },
    { id: 'test-proj', kind: 'general' },
  ];

  let selectedId: string | null = null;
  let closeCalled = false;

  const app = React.createElement(ProjectSwitcher, {
    open: true,
    projects,
    loading: false,
    error: null,
    onSelect: (id: string) => { selectedId = id; },
    onClose: () => { closeCalled = true; },
    onRequestRefresh: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Press Enter to select the first project
  instance.stdin.write('\r');
  await delay(100);

  assert.equal(selectedId, 'general', 'Enter selects first project');
  assert.equal(closeCalled, true, 'onClose called after selection');

  instance.unmount();
  instance.cleanup();
});

test('ProjectSwitcher escape closes', async (t) => {
  let closeCalled = false;

  const app = React.createElement(ProjectSwitcher, {
    open: true,
    projects: [{ id: 'general' }],
    loading: false,
    error: null,
    onSelect: () => {},
    onClose: () => { closeCalled = true; },
    onRequestRefresh: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Press Escape
  instance.stdin.write('\x1b');
  await delay(100);

  assert.equal(closeCalled, true, 'Escape calls onClose');

  instance.unmount();
  instance.cleanup();
});
