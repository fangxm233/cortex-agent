import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '@/design';
import { useSelectedSession } from '@/features/workbench/SelectedSessionProvider';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useNotificationFeed } from './useNotificationFeed';
import { notificationToast } from './publish-notification';
import type { NotificationItem } from './notification-vm';

/** Subscribes the desktop shell to the live notification feed and pushes each item onto the shared
 *  bubble queue. Renders nothing — `ToastViewport` (design) is the one stack on screen. */
export function NotificationProvider() {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { selectedSessionId, setSelectedSession } = useSelectedSession();
  const { setCurrentProject } = useCurrentProject();
  const isSessionOpen = useCallback(
    (sessionId: string) => location.pathname.startsWith('/workbench') && selectedSessionId === sessionId,
    [location.pathname, selectedSessionId],
  );

  const publish = useCallback((item: NotificationItem) => {
    const activate = item.sessionId
      ? () => {
        if (item.projectId) setCurrentProject(item.projectId);
        setSelectedSession(item.sessionId);
        navigate('/workbench');
      }
      : undefined;
    toast(notificationToast(item, activate));
  }, [navigate, setCurrentProject, setSelectedSession, toast]);

  useNotificationFeed({ isSessionOpen, publish });
  return null;
}
