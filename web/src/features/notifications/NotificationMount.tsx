// input:  Notification feed, local delivery, project/session state
// output: NotificationMount
// pos:    Desktop layout notification delivery and activation
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '@/design';
import { useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useNotificationFeed } from './useNotificationFeed';
import { notificationToast } from './publish-notification';
import { notificationForeground } from './local-notification-state';
import { useLocalNotificationDelivery, type NotificationSession } from './useLocalNotificationDelivery';
import type { NotificationItem } from './notification-vm';

function useSessionNavigation() {
  const navigate = useNavigate();
  const { setSelectedSession } = useSelectedSession();
  const { setCurrentProject } = useCurrentProject();
  return useCallback((session: NotificationSession | null) => {
    if (session?.projectId) setCurrentProject(session.projectId);
    if (session) setSelectedSession(session.sessionId);
    navigate('/workbench');
  }, [navigate, setCurrentProject, setSelectedSession]);
}

function useSessionOpen() {
  const location = useLocation();
  const { selectedSessionId } = useSelectedSession();
  const current = useRef({ pathname: location.pathname, selectedSessionId });
  current.current = { pathname: location.pathname, selectedSessionId };
  return useCallback((sessionId: string) => notificationForeground()
    && current.current.pathname.startsWith('/workbench') && current.current.selectedSessionId === sessionId, []);
}

/** Foreground uses the shared bubble queue; background uses one OS adapter. */
export function NotificationMount() {
  const { toast } = useToast();
  const navigate = useSessionNavigation();
  const isSessionOpen = useSessionOpen();
  const externalDelivery = useLocalNotificationDelivery(navigate);
  const publish = useCallback((item: NotificationItem) => {
    const activate = item.sessionId ? () => navigate(item) : undefined;
    toast(notificationToast(item, activate));
  }, [navigate, toast]);
  useNotificationFeed({ isSessionOpen, publish, externalDelivery });
  return null;
}
