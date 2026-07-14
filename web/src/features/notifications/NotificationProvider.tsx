import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useSelectedSession } from '@/features/workbench/SelectedSessionProvider';
import { useCurrentProject } from '@/features/workbench/CurrentProjectProvider';
import { NotificationToaster } from './NotificationToaster';
import { useDmNotifications, type DmAssistantMessage } from './useDmNotifications';
import { addNotification, removeNotification } from './notification-store';
import { buildNotification, type NotificationItem } from './notification-vm';

// Wires the global assistant `session.message` stream into scheme-18a notification toasts:
//   · gates to DIRECT chat sessions (origin='direct') — thread/scheduled agent chatter never toasts;
//   · suppresses the session currently open in the workbench chat (no double display);
//   · click-through re-points project + session and navigates to /workbench.
// Owns the pure queue (notification-store) and renders the pure NotificationToaster. Mounted in
// AppShell inside CurrentProject + SelectedSession providers (desktop shell only).

interface DirectEntry {
  name: string | null;
  projectId: string | null;
}

export function NotificationProvider() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedSessionId, setSelectedSession } = useSelectedSession();
  const { setCurrentProject } = useCurrentProject();

  const [items, setItems] = useState<NotificationItem[]>([]);
  const counter = useRef(0);

  // Latest-value refs so the SSE `onMessage` callback stays stable (no resubscribe churn).
  const directMapRef = useRef<Map<string, DirectEntry>>(new Map());
  const selectedRef = useRef<string | null>(selectedSessionId);
  const pathRef = useRef<string>(location.pathname);

  // All direct sessions across projects — the membership gate + title/project source.
  const directSessions = useQuery(trpc.sessions.list.queryOptions({ origin: 'direct' }));
  useEffect(() => {
    const map = new Map<string, DirectEntry>();
    for (const s of directSessions.data ?? []) {
      map.set(s.sessionId, { name: s.label ?? s.name, projectId: s.projectId });
    }
    directMapRef.current = map;
  }, [directSessions.data]);

  useEffect(() => {
    selectedRef.current = selectedSessionId;
  }, [selectedSessionId]);
  useEffect(() => {
    pathRef.current = location.pathname;
  }, [location.pathname]);

  const onMessage = useCallback((msg: DmAssistantMessage) => {
    const entry = directMapRef.current.get(msg.sessionId);
    if (!entry) return; // not a direct DM session (thread/scheduled/unknown) — do not toast
    // Suppress when the message's session is the one open in the workbench chat.
    if (pathRef.current.startsWith('/workbench') && selectedRef.current === msg.sessionId) return;
    const id = `dmn-${counter.current++}`;
    const item = buildNotification({
      id,
      sessionId: msg.sessionId,
      sessionName: entry.name,
      projectId: entry.projectId,
      text: msg.text,
      ts: msg.ts ?? undefined,
    });
    setItems((list) => addNotification(list, item));
  }, []);

  useDmNotifications(onMessage);

  const dismiss = useCallback((id: string) => setItems((list) => removeNotification(list, id)), []);

  const activate = useCallback(
    (item: NotificationItem) => {
      if (item.projectId) setCurrentProject(item.projectId);
      setSelectedSession(item.sessionId);
      navigate('/workbench');
      setItems((list) => removeNotification(list, item.id));
    },
    [navigate, setCurrentProject, setSelectedSession],
  );

  return <NotificationToaster items={items} onDismiss={dismiss} onActivate={activate} />;
}
