// input:  mobile router, shared reply feed and native notifications
// output: tap routing, OS replies, on-screen sync and background lifecycle
// pos:    Mobile notification adapter and native service owner
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '@/design';
import { useLang } from '@/i18n';
import { useTRPCClient } from '@/lib/trpc';
import { mobileNotificationStatus, setNativeVisibleSession } from '@/lib/native-bridge';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useNotificationFeed } from '@/features/notifications/useNotificationFeed';
import {
  nativeCompletionNotifications, useMobileNotificationLifecycle,
} from '@/features/notifications/mobile-notifications';
import { notificationToast } from '@/features/notifications/publish-notification';
import type { NotificationItem } from '@/features/notifications/notification-vm';
import { sendOsNotification, osNotificationSpec, onOsNotificationAction } from '@/features/notifications/os-notify';
import { notificationTargetId, resolveNotificationRoute, sessionPathId } from './m-notification-routing';
import { MNotificationBanners } from './MNotificationToaster';

function useNotificationActions(): void {
  const client = useTRPCClient();
  const navigate = useNavigate();
  const { setCurrentProject } = useCurrentProject();
  useEffect(() => {
    const controller = new AbortController();
    let cleanup = () => {};
    void onOsNotificationAction(async (data) => {
      if (!data || controller.signal.aborted) return false;
      const route = await resolveNotificationRoute(data, {
        sessions: () => client.sessions.list.query({ origin: 'direct' }),
        approvals: () => client.approvals.list.query({ status: 'pending' }),
      });
      const status = data.scope === undefined ? null : await mobileNotificationStatus();
      if (controller.signal.aborted || (data.scope !== undefined && data.scope !== status?.scope)) return false;
      if (route.projectId) setCurrentProject(route.projectId);
      navigate(route.path);
    }, controller.signal).then((off) => {
      if (controller.signal.aborted) off();
      else cleanup = off;
    });
    return () => { controller.abort(); cleanup(); };
  }, [client, navigate, setCurrentProject]);
}

// The shared feed emits replies/system notices only. Native alone owns interactions/approvals,
// and owns the turn-completion notification too once the background service reports it.
function externalDelivery(item: NotificationItem): Promise<boolean> {
  if (item.sessionId && nativeCompletionNotifications()) return Promise.resolve(true);
  const data: Record<string, string> = item.sessionId
    ? { kind: 'session', sessionId: item.sessionId, projectId: item.projectId ?? '' }
    : { kind: 'sessions' };
  return sendOsNotification(osNotificationSpec(item), data);
}

function useVisibleSessionPredicate() {
  const location = useLocation();
  const pathname = useRef(location.pathname);
  pathname.current = location.pathname;
  return useCallback((sessionId: string) => document.visibilityState === 'visible'
    && sessionPathId(pathname.current) === sessionId, []);
}

/** Native suppresses the session on screen. Activity pause clears it without this page. */
function useNativeVisibleSession(): void {
  const sessionId = sessionPathId(useLocation().pathname);
  useEffect(() => {
    const push = () => {
      void setNativeVisibleSession(document.visibilityState === 'visible' ? sessionId : null);
    };
    push();
    document.addEventListener('visibilitychange', push);
    return () => {
      document.removeEventListener('visibilitychange', push);
      void setNativeVisibleSession(null);
    };
  }, [sessionId]);
}

export function MNotificationMount() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { setCurrentProject } = useCurrentProject();
  useMobileNotificationLifecycle(useLang());
  useNotificationActions();
  useNativeVisibleSession();

  const openSession = useCallback((sessionId: string, projectId: string | null) => {
    if (!notificationTargetId(sessionId)) { navigate('/m/sessions'); return; }
    if (projectId) setCurrentProject(projectId);
    navigate(`/m/session/${encodeURIComponent(sessionId)}`);
  }, [navigate, setCurrentProject]);

  const isSessionOpen = useVisibleSessionPredicate();
  const publish = useCallback((item: NotificationItem) => {
    toast(notificationToast(item, () => openSession(item.sessionId, item.projectId)));
  }, [openSession, toast]);
  useNotificationFeed({ isSessionOpen, publish, externalDelivery });
  return <MNotificationBanners />;
}
