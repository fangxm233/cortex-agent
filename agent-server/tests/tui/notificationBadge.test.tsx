// input:  an open notifications modal with one selectable notification
// output: verifies keyboard selection invokes the owning callback with the source entity
// pos:    TUI notification interaction regression; badge/empty-state chrome is not snapshot-tested

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { NotificationsModal } from '../../src/tui/components/Notifications.js';
import type { NotificationEntry } from '../../src/tui/hooks/useNotifications.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('NotificationsModal onSelect fires when Enter pressed in detail view', async () => {
  const notif: NotificationEntry = {
    id: 'n1',
    kind: 'project-report',
    projectId: 'project-x',
    title: 'Test Report',
    body: 'Report body',
    ts: Date.now(),
    read: false,
  };
  const notifications = new Map<string, NotificationEntry>([['n1', notif]]);
  let selectedNotif: NotificationEntry | null = null;

  const instance = render(React.createElement(NotificationsModal, {
    open: true,
    notifications,
    ids: ['n1'],
    onMarkRead: () => {},
    onClose: () => {},
    onSelect: (n: NotificationEntry) => { selectedNotif = n; },
  }));
  await delay(200);

  instance.stdin.write('\r');
  await delay(200);
  instance.stdin.write('\r');
  await delay(200);

  assert.ok(selectedNotif !== null, 'onSelect was called');
  assert.equal(selectedNotif!.id, 'n1');
  assert.equal(selectedNotif!.projectId, 'project-x');

  instance.unmount();
  instance.cleanup();
});
