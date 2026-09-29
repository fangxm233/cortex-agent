import { useState, useCallback } from 'react';
import type { Notification } from '../../platform/tui/protocol.js';

// ── Constants ──

const MAX_NOTIFICATIONS = 50;

// ── Types ──

export interface NotificationEntry {
  id: string;
  kind: 'project-report' | 'system-notice' | 'thread-report';
  projectId: string;
  sessionId?: string | null;
  title: string;
  body: string;
  ts: number;
  read: boolean;
}

export interface NotifState {
  notifications: Map<string, NotificationEntry>;
  ids: string[];
  unreadCount: number;
}

export const EMPTY_NOTIF_STATE: NotifState = {
  notifications: new Map(),
  ids: [],
  unreadCount: 0,
};

// ── Pure state helpers (exported for testing) ──

export function _addNotification(prev: NotifState, frame: Notification): NotifState {
  const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: NotificationEntry = {
    id,
    kind: frame.kind,
    projectId: frame.projectId,
    sessionId: frame.sessionId ?? null,
    title: frame.title,
    body: frame.body,
    ts: Date.now(),
    read: false,
  };

  const notifications = new Map(prev.notifications);
  const ids = [...prev.ids, id];
  notifications.set(id, entry);

  // Evict oldest if over cap
  while (ids.length > MAX_NOTIFICATIONS) {
    const oldestId = ids.shift()!;
    notifications.delete(oldestId);
  }

  return { notifications, ids, unreadCount: prev.unreadCount + 1 };
}

export function _markRead(prev: NotifState, notificationId: string): NotifState {
  const existing = prev.notifications.get(notificationId);
  if (!existing || existing.read) return prev;

  const notifications = new Map(prev.notifications);
  notifications.set(notificationId, { ...existing, read: true });
  return {
    notifications,
    ids: prev.ids,
    unreadCount: Math.max(0, prev.unreadCount - 1),
  };
}

// ── Hook ──

export function useNotifications(): {
  notifications: Map<string, NotificationEntry>;
  ids: string[];
  unreadCount: number;
  add: (frame: Notification) => void;
  markRead: (id: string) => void;
} {
  const [state, setState] = useState<NotifState>(EMPTY_NOTIF_STATE);

  const add = useCallback((frame: Notification): void => {
    setState(prev => _addNotification(prev, frame));
  }, []);

  const markRead = useCallback((id: string): void => {
    setState(prev => _markRead(prev, id));
  }, []);

  return {
    notifications: state.notifications,
    ids: state.ids,
    unreadCount: state.unreadCount,
    add,
    markRead,
  };
}
