// input:  direct-session snapshots, live DM turns/system notices, open-session predicate, external delivery
// output: unified deduped in-app notification queue with async external-delivery fallback
// pos:    Shared desktop/mobile notification feed controller
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { addNotification, removeNotification } from './notification-store';
import { buildNotification, buildSystemNotice, type NotificationItem } from './notification-vm';
import { recordTurnMessage, takeTurnMessage, type BufferedTurnMessage } from './turn-buffer';
import { useDmNotifications, type DmAssistantMessage } from './useDmNotifications';
import { useSystemNotices, type SystemNoticeMessage } from './useSystemNotices';

interface DirectEntry {
  name: string | null;
  projectId: string | null;
}

type DirectSession = Pick<SessionInfo, 'sessionId' | 'label' | 'name' | 'projectId'>;
type Deliver = (item: NotificationItem) => void;
type NextId = (prefix: 'dmn' | 'sysn') => string;
type ItemSetter = Dispatch<SetStateAction<NotificationItem[]>>;

export interface UseNotificationFeedOptions {
  isSessionOpen: (sessionId: string) => boolean;
  externalDelivery?: (item: NotificationItem) => Promise<boolean>;
}

export interface NotificationFeed {
  items: NotificationItem[];
  dismiss: (id: string) => void;
}

function toDirectMap(sessions: readonly DirectSession[] | undefined): Map<string, DirectEntry> {
  const map = new Map<string, DirectEntry>();
  for (const session of sessions ?? []) {
    map.set(session.sessionId, {
      name: session.label ?? session.name,
      projectId: session.projectId,
    });
  }
  return map;
}

function useDirectMap(): Map<string, DirectEntry> {
  const trpc = useTRPC();
  const query = useQuery(trpc.sessions.list.queryOptions({ origin: 'direct' }));
  return useMemo(() => toDirectMap(query.data), [query.data]);
}

function useMountedRef(): React.MutableRefObject<boolean> {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

function useDelivery(
  setItems: ItemSetter,
  externalDelivery: UseNotificationFeedOptions['externalDelivery'],
): Deliver {
  const mounted = useMountedRef();
  return useCallback((item: NotificationItem) => {
    void (async () => {
      try {
        if (externalDelivery && await externalDelivery(item)) return;
      } catch {
        // External delivery is best-effort; rejection takes the same in-app fallback as false.
      }
      if (mounted.current) setItems((list) => addNotification(list, item));
    })();
  }, [externalDelivery, mounted, setItems]);
}

function buildDmItem(
  buffer: Map<string, BufferedTurnMessage>,
  directMap: Map<string, DirectEntry>,
  isSessionOpen: (sessionId: string) => boolean,
  nextId: NextId,
  sessionId: string,
): NotificationItem | null {
  const message = takeTurnMessage(buffer, sessionId);
  if (!message) return null;
  const entry = directMap.get(sessionId);
  if (!entry || isSessionOpen(sessionId)) return null;
  return buildNotification({
    id: nextId('dmn'), sessionId, sessionName: entry.name,
    projectId: entry.projectId, text: message.text, ts: message.ts,
  });
}

function useDmFeed(
  directMap: Map<string, DirectEntry>,
  isSessionOpen: (sessionId: string) => boolean,
  nextId: NextId,
  deliver: Deliver,
): void {
  const buffer = useRef<Map<string, BufferedTurnMessage>>(new Map());
  const onMessage = useCallback((message: DmAssistantMessage) => {
    recordTurnMessage(buffer.current, message.sessionId, {
      text: message.text,
      ts: message.ts ?? new Date().toISOString(),
    });
  }, []);
  const onTurnEnd = useCallback((sessionId: string) => {
    const item = buildDmItem(buffer.current, directMap, isSessionOpen, nextId, sessionId);
    if (item) deliver(item);
  }, [deliver, directMap, isSessionOpen, nextId]);
  useDmNotifications({ onMessage, onTurnEnd });
}

function useNoticeFeed(nextId: NextId, deliver: Deliver): void {
  const onNotice = useCallback((message: SystemNoticeMessage) => {
    deliver(buildSystemNotice({
      id: nextId('sysn'),
      level: message.level,
      text: message.text,
      title: message.title ?? undefined,
      ts: message.ts ?? undefined,
    }));
  }, [deliver, nextId]);
  useSystemNotices(onNotice);
}

export function useNotificationFeed({
  isSessionOpen,
  externalDelivery,
}: UseNotificationFeedOptions): NotificationFeed {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const counter = useRef(0);
  const directMap = useDirectMap();
  const deliver = useDelivery(setItems, externalDelivery);
  const nextId = useCallback<NextId>((prefix) => `${prefix}-${counter.current++}`, []);
  useDmFeed(directMap, isSessionOpen, nextId, deliver);
  useNoticeFeed(nextId, deliver);
  const dismiss = useCallback((id: string) => {
    setItems((list) => removeNotification(list, id));
  }, []);
  return { items, dismiss };
}
