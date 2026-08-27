// input:  mobile router/project state, shared notification feed, and native notification bridge
// output: OS-delivered or fallback in-app notifications with session deep-links
// pos:    Thin mobile adapter for shared feed delivery, actions, navigation, and toaster
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useNotificationFeed } from '@/features/notifications/useNotificationFeed';
import type { NotificationItem } from '@/features/notifications/notification-vm';
import {
  ensureOsNotifyPermission,
  sendOsNotification,
  osNotificationSpec,
  onOsNotificationAction,
} from '@/features/notifications/os-notify';
import { MNotificationToaster } from './MNotificationToaster';

export function MNotificationProvider() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setCurrentProject } = useCurrentProject();

  useEffect(() => {
    void ensureOsNotifyPermission();
  }, []);

  const openSession = useCallback((sessionId: string, projectId: string | null) => {
    if (!sessionId) return;
    if (projectId) setCurrentProject(projectId);
    navigate(`/m/session/${sessionId}`);
  }, [navigate, setCurrentProject]);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void onOsNotificationAction((data) => {
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
      const projectId = typeof data?.projectId === 'string' && data.projectId ? data.projectId : null;
      openSession(sessionId, projectId);
    }).then((unsubscribe) => {
      if (disposed) unsubscribe();
      else cleanup = unsubscribe;
    });
    return () => { disposed = true; cleanup(); };
  }, [openSession]);

  const externalDelivery = useCallback((item: NotificationItem): Promise<boolean> => {
    const data = item.sessionId
      ? { sessionId: item.sessionId, projectId: item.projectId ?? '' }
      : undefined;
    return sendOsNotification(osNotificationSpec(item), data);
  }, []);
  const isSessionOpen = useCallback(
    (sessionId: string) => location.pathname === `/m/session/${sessionId}`,
    [location.pathname],
  );
  const { items, dismiss } = useNotificationFeed({ isSessionOpen, externalDelivery });

  const activate = useCallback((item: NotificationItem) => {
    openSession(item.sessionId, item.projectId);
    dismiss(item.id);
  }, [dismiss, openSession]);

  return <MNotificationToaster items={items} onDismiss={dismiss} onActivate={activate} />;
}
