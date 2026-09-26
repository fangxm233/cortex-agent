import { useCallback, useEffect, useRef } from 'react';
import { isDesktopShell } from '@/lib/desktop-config';
import { useTRPCClient } from '@/lib/trpc';
import { createBrowserNotifications } from './browser-notifications';
import { listenDesktopNotificationActions, sendDesktopNotification } from './desktop-notifications';
import { localNotificationsEnabled, notificationForeground } from './local-notification-state';
import { osNotificationSpec } from './os-notify';
import type { NotificationItem } from './notification-vm';

export interface NotificationSession { sessionId: string; projectId: string | null }
type NavigateSession = (session: NotificationSession | null) => void;
type Target = { sessionId?: string };
type Route = (target: Target, current: () => boolean) => Promise<boolean>;

function validTarget(id: string): boolean {
  if (!id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) return false;
  try { encodeURIComponent(id); return true; } catch { return false; }
}

function useSessionRoute(navigate: NavigateSession): Route {
  const client = useTRPCClient();
  return useCallback(async (target, current) => {
    if (!current()) return false;
    if (!target.sessionId) return true; // System notices only restore/focus the window.
    const id = target.sessionId;
    const sessions = validTarget(id) ? await client.sessions.list.query({ origin: 'direct' }) : [];
    if (!current()) return false;
    navigate(sessions.find((session) => session.sessionId === id) ?? null);
    return true;
  }, [client, navigate]);
}

function useAdapters(route: Route) {
  const browser = useRef<ReturnType<typeof createBrowserNotifications> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let off = () => {};
    browser.current = createBrowserNotifications();
    if (isDesktopShell()) {
      void listenDesktopNotificationActions(route, controller.signal).then((cleanup) => {
        if (controller.signal.aborted) cleanup();
        else off = cleanup;
      });
    }
    return () => { controller.abort(); off(); browser.current?.dispose(); browser.current = null; };
  }, [route]);
  return browser;
}

export function useLocalNotificationDelivery(navigate: NavigateSession) {
  const route = useSessionRoute(navigate);
  const browser = useAdapters(route);
  return useCallback(async (item: NotificationItem): Promise<boolean> => {
    if (!localNotificationsEnabled() || notificationForeground()) return false;
    const spec = osNotificationSpec(item);
    const data = { sessionId: item.sessionId || undefined, projectId: item.projectId ?? undefined };
    if (isDesktopShell()) return sendDesktopNotification(spec, data);
    return browser.current?.send(spec, async (current) => { await route(data, current); }) ?? false;
  }, [browser, route]);
}
