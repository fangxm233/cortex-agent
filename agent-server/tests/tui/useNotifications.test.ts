// input:  src/tui/hooks/useNotifications.js (pure state helpers)
// output: Tests — ring buffer cap 50, add, markRead, overflow eviction, unreadCount
// pos:    Verifies notification ring buffer behavior

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  _addNotification, _markRead,
  EMPTY_NOTIF_STATE,
} from '../../src/tui/hooks/useNotifications.js';
import type { Notification } from '../../src/platform/tui/protocol.js';

// ── Helpers ──

function makeNotifFrame(overrides?: Partial<Notification>): Notification {
  return {
    type: 'notification',
    kind: 'project-report',
    projectId: 'test-proj',
    title: 'Test title',
    body: 'Test body',
    seq: 1,
    ...overrides,
  } as Notification;
}

// ── Tests ──

test('_addNotification adds entry and increments unreadCount', () => {
  const state = _addNotification(EMPTY_NOTIF_STATE, makeNotifFrame({ kind: 'project-report' }));

  assert.equal(state.ids.length, 1);
  assert.equal(state.notifications.size, 1);
  assert.equal(state.unreadCount, 1);

  const entry = state.notifications.get(state.ids[0])!;
  assert.equal(entry.title, 'Test title');
  assert.equal(entry.kind, 'project-report');
  assert.equal(entry.read, false);
});

test('ring buffer evicts oldest at cap 50', () => {
  let state = EMPTY_NOTIF_STATE;
  for (let i = 0; i < 52; i++) {
    state = _addNotification(state, makeNotifFrame({ title: `Notif ${i}`, seq: i }));
  }

  assert.equal(state.ids.length, 50);
  assert.equal(state.notifications.size, 50);
  assert.equal(state.unreadCount, 52); // unreadCount is logical count, not buffer size

  // Verify oldest was evicted
  const titles = state.ids.map(id => state.notifications.get(id)!.title);
  assert.ok(!titles.includes('Notif 0'), 'oldest notification evicted');
  assert.ok(titles.includes('Notif 51'), 'most recent notification present');
});

test('multiple adds and reads interleaved', () => {
  let state = EMPTY_NOTIF_STATE;

  state = _addNotification(state, makeNotifFrame({ title: 'A', kind: 'project-report' }));
  state = _addNotification(state, makeNotifFrame({ title: 'B', kind: 'system-notice' }));
  state = _addNotification(state, makeNotifFrame({ title: 'C', kind: 'thread-report' }));

  assert.equal(state.ids.length, 3);
  assert.equal(state.unreadCount, 3);

  // Mark B read
  state = _markRead(state, state.ids[1]);
  assert.equal(state.unreadCount, 2);
  assert.equal(state.notifications.get(state.ids[1])!.read, true);

  // Mark A read
  state = _markRead(state, state.ids[0]);
  assert.equal(state.unreadCount, 1);

  // Mark A again — no-op
  state = _markRead(state, state.ids[0]);
  assert.equal(state.unreadCount, 1);
});
