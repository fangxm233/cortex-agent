// Mobile 1q notification wiring — surfaces the real assistant `session.message` stream + server
// `system.notice` broadcasts as scheme-1q top banners. Reuses the desktop pure notification layer
// (store / vm / turn-buffer / useDmNotifications / useSystemNotices); only the navigation + open-session
// suppression are mobile-specific. Mounted in MobileShell (inside MobileProjectProvider + the router).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useMobileProject } from '@/mobile/current-project';
import { useDmNotifications, type DmAssistantMessage } from '@/features/notifications/useDmNotifications';
import { useSystemNotices, type SystemNoticeMessage } from '@/features/notifications/useSystemNotices';
import { addNotification, removeNotification, splitVisible } from '@/features/notifications/notification-store';
import { recordTurnMessage, takeTurnMessage, type BufferedTurnMessage } from '@/features/notifications/turn-buffer';
import { buildNotification, buildSystemNotice, type NotificationItem } from '@/features/notifications/notification-vm';
import { MNotificationToaster } from './MNotificationToaster';

interface DirectEntry {
  name: string | null;
  projectId: string | null;
}

export function MNotificationProvider() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const location = useLocation();
  const { setCurrentProject } = useMobileProject();

  const [items, setItems] = useState<NotificationItem[]>([]);
  const counter = useRef(0);

  const directMapRef = useRef<Map<string, DirectEntry>>(new Map());
  const pathRef = useRef<string>(location.pathname);

  const directSessions = useQuery(trpc.sessions.list.queryOptions({ origin: 'direct' }));
  useEffect(() => {
    const map = new Map<string, DirectEntry>();
    for (const s of directSessions.data ?? []) {
      map.set(s.sessionId, { name: s.label ?? s.name, projectId: s.projectId });
    }
    directMapRef.current = map;
  }, [directSessions.data]);

  useEffect(() => {
    pathRef.current = location.pathname;
  }, [location.pathname]);

  const turnBufferRef = useRef<Map<string, BufferedTurnMessage>>(new Map());

  const onMessage = useCallback((msg: DmAssistantMessage) => {
    recordTurnMessage(turnBufferRef.current, msg.sessionId, {
      text: msg.text,
      ts: msg.ts ?? new Date().toISOString(),
    });
  }, []);

  const onTurnEnd = useCallback((sessionId: string) => {
    const buffered = takeTurnMessage(turnBufferRef.current, sessionId);
    if (!buffered) return;
    const entry = directMapRef.current.get(sessionId);
    if (!entry) return; // not a direct DM session — do not toast
    // Suppress when the session's chat page is currently open on mobile.
    if (pathRef.current === `/m/session/${sessionId}`) return;
    const id = `dmn-${counter.current++}`;
    const item = buildNotification({
      id,
      sessionId,
      sessionName: entry.name,
      projectId: entry.projectId,
      text: buffered.text,
      ts: buffered.ts,
    });
    setItems((list) => addNotification(list, item));
  }, []);

  useDmNotifications({ onMessage, onTurnEnd });

  const onSystemNotice = useCallback((msg: SystemNoticeMessage) => {
    const id = `sysn-${counter.current++}`;
    const item = buildSystemNotice({
      id,
      level: msg.level,
      text: msg.text,
      title: msg.title ?? undefined,
      ts: msg.ts ?? undefined,
    });
    setItems((list) => addNotification(list, item));
  }, []);

  useSystemNotices(onSystemNotice);

  const dismiss = useCallback((id: string) => setItems((list) => removeNotification(list, id)), []);

  const activate = useCallback(
    (item: NotificationItem) => {
      if (item.sessionId) {
        if (item.projectId) setCurrentProject(item.projectId);
        navigate(`/m/session/${item.sessionId}`);
      }
      setItems((list) => removeNotification(list, item.id));
    },
    [navigate, setCurrentProject],
  );

  const { visible } = splitVisible(items);
  return <MNotificationToaster items={visible} onDismiss={dismiss} onActivate={activate} />;
}
