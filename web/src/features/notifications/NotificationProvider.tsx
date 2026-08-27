// input:  selected workbench session, project scope, router state, and shared notification feed
// output: desktop notification navigation and toaster presentation
// pos:    Thin desktop adapter for the shared notification feed
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelectedSession } from '@/features/workbench/SelectedSessionProvider';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { NotificationToaster } from './NotificationToaster';
import { useNotificationFeed } from './useNotificationFeed';
import type { NotificationItem } from './notification-vm';

export function NotificationProvider() {
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedSessionId, setSelectedSession } = useSelectedSession();
  const { setCurrentProject } = useCurrentProject();
  const isSessionOpen = useCallback(
    (sessionId: string) => location.pathname.startsWith('/workbench') && selectedSessionId === sessionId,
    [location.pathname, selectedSessionId],
  );
  const { items, dismiss } = useNotificationFeed({ isSessionOpen });

  const activate = useCallback((item: NotificationItem) => {
    if (item.sessionId) {
      if (item.projectId) setCurrentProject(item.projectId);
      setSelectedSession(item.sessionId);
      navigate('/workbench');
    }
    dismiss(item.id);
  }, [dismiss, navigate, setCurrentProject, setSelectedSession]);

  return <NotificationToaster items={items} onDismiss={dismiss} onActivate={activate} />;
}
