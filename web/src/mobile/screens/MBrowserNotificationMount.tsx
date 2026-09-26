// input:  Shared feed and browser delivery, mobile router
// output: MBrowserNotificationMount
// pos:    Ordinary mobile browser notification integration
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '@/design';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useNotificationFeed } from '@/features/notifications/useNotificationFeed';
import { notificationForeground } from '@/features/notifications/local-notification-state';
import { notificationToast } from '@/features/notifications/publish-notification';
import { useLocalNotificationDelivery, type NotificationSession } from '@/features/notifications/useLocalNotificationDelivery';
import type { NotificationItem } from '@/features/notifications/notification-vm';
import { sessionPathId } from './m-notification-routing';
import { MNotificationBanners } from './MNotificationToaster';

function useBrowserSessionRoute() {
  const navigate = useNavigate();
  const { setCurrentProject } = useCurrentProject();
  return useCallback((session: NotificationSession | null) => {
    if (session?.projectId) setCurrentProject(session.projectId);
    navigate(session ? `/m/session/${encodeURIComponent(session.sessionId)}` : '/m/sessions');
  }, [navigate, setCurrentProject]);
}

export function MBrowserNotificationMount() {
  const { toast } = useToast();
  const navigate = useBrowserSessionRoute();
  const pathname = useRef(useLocation().pathname);
  pathname.current = useLocation().pathname;
  const externalDelivery = useLocalNotificationDelivery(navigate);
  const isSessionOpen = useCallback((id: string) => notificationForeground()
    && sessionPathId(pathname.current) === id, []);
  const publish = useCallback((item: NotificationItem) => {
    toast(notificationToast(item, item.sessionId ? () => navigate(item) : undefined));
  }, [navigate, toast]);
  useNotificationFeed({ isSessionOpen, publish, externalDelivery });
  return <MNotificationBanners />;
}
