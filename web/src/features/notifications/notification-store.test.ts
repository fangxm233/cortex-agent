import { describe, expect, it } from 'vitest';
import {
  MAX_VISIBLE,
  addNotification,
  removeNotification,
  splitVisible,
} from './notification-store';
import type { NotificationItem } from './notification-vm';

function make(id: string, over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id,
    level: 'info',
    title: `t-${id}`,
    meta: `m-${id}`,
    ts: '2026-07-14T00:00:00.000Z',
    sessionId: `s-${id}`,
    projectId: 'p',
    ...over,
  };
}

describe('notification-store', () => {
  it('appends a notification to the end (newest last)', () => {
    const list = addNotification([make('a')], make('b'));
    expect(list.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('skips a consecutive duplicate (same session + same preview)', () => {
    const first = make('a', { sessionId: 's1', meta: 'hello' });
    const dupNewId = make('b', { sessionId: 's1', meta: 'hello' });
    const list = addNotification([first], dupNewId);
    expect(list.map((n) => n.id)).toEqual(['a']);
  });

  it('does NOT skip when the same session sends different text', () => {
    const first = make('a', { sessionId: 's1', meta: 'hello' });
    const second = make('b', { sessionId: 's1', meta: 'world' });
    const list = addNotification([first], second);
    expect(list.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('does NOT skip when different sessions send the same text', () => {
    const first = make('a', { sessionId: 's1', meta: 'hello' });
    const second = make('b', { sessionId: 's2', meta: 'hello' });
    const list = addNotification([first], second);
    expect(list.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('removes a notification by id', () => {
    const list = removeNotification([make('a'), make('b'), make('c')], 'b');
    expect(list.map((n) => n.id)).toEqual(['a', 'c']);
  });

  it('is a no-op when removing an unknown id', () => {
    const start = [make('a'), make('b')];
    expect(removeNotification(start, 'zzz').map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the input list on add or remove', () => {
    const start = [make('a')];
    addNotification(start, make('b'));
    removeNotification(start, 'a');
    expect(start.map((n) => n.id)).toEqual(['a']);
  });

  it('splitVisible: no overflow when at/under the cap (newest visible)', () => {
    const list = [make('a'), make('b'), make('c')];
    const { visible, overflow } = splitVisible(list);
    expect(visible.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(overflow).toBe(0);
  });

  it('splitVisible: keeps the newest MAX_VISIBLE and counts the rest as overflow', () => {
    const list = [make('a'), make('b'), make('c'), make('d'), make('e')];
    const { visible, overflow } = splitVisible(list);
    expect(visible).toHaveLength(MAX_VISIBLE);
    // newest MAX_VISIBLE, in order (oldest-of-visible first, newest last)
    expect(visible.map((n) => n.id)).toEqual(['c', 'd', 'e']);
    expect(overflow).toBe(2);
  });
});
