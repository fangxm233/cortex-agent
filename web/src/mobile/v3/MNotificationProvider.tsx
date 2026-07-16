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
import {
  ensureOsNotifyPermission,
  sendOsNotification,
  osNotificationSpec,
  onOsNotificationAction,
} from '@/features/notifications/os-notify';
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

  // Prompt for OS-notification permission once on mount (no-op in a plain browser). Getting the grant
  // early means the first real notification fires as a system notification, not the in-app fallback.
  useEffect(() => {
    void ensureOsNotifyPermission();
  }, []);

  // Open a DM session (re-point the current project, then drill into the chat). Shared by the OS
  // notification-tap handler (design 1q "轻点直达对应会话") and the in-app fallback toaster's tap.
  const openSession = useCallback(
    (sessionId: string, projectId: string | null) => {
      if (!sessionId) return;
      if (projectId) setCurrentProject(projectId);
      navigate(`/m/session/${sessionId}`);
    },
    [navigate, setCurrentProject],
  );

  // Route a native notification tap. The `data` payload is the {sessionId, projectId} we stored in the
  // notification's `extra` when sending — read it back and deep-link. No-op off-shell (browser).
  useEffect(() => {
    let cleanup = () => {};
    void onOsNotificationAction((data) => {
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
      const projectId = typeof data?.projectId === 'string' && data.projectId ? data.projectId : null;
      openSession(sessionId, projectId);
    }).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup();
  }, [openSession]);

  // Deliver a notification as a native OS/system notification (design 1q: mobile uses system push).
  // Falls back to the in-app banner only when the OS path cannot deliver (plain browser, permission
  // denied, or a plugin error) so a notification is never silently dropped. The nav payload
  // (sessionId/projectId) rides along in `extra` so a tap can deep-link back to the session.
  const deliver = useCallback((item: NotificationItem) => {
    const data = item.sessionId
      ? { sessionId: item.sessionId, projectId: item.projectId ?? '' }
      : undefined;
    void (async () => {
      const sent = await sendOsNotification(osNotificationSpec(item), data);
      if (!sent) setItems((list) => addNotification(list, item));
    })();
  }, []);

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
    deliver(item);
  }, [deliver]);

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
    deliver(item);
  }, [deliver]);

  useSystemNotices(onSystemNotice);

  const dismiss = useCallback((id: string) => setItems((list) => removeNotification(list, id)), []);

  const activate = useCallback(
    (item: NotificationItem) => {
      openSession(item.sessionId, item.projectId);
      setItems((list) => removeNotification(list, item.id));
    },
    [openSession],
  );

  const { visible } = splitVisible(items);
  return <MNotificationToaster items={visible} onDismiss={dismiss} onActivate={activate} />;
}
