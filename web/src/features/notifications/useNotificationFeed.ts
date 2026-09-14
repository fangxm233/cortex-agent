import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { buildNotification, buildSystemNotice, type NotificationItem } from './notification-vm';
import { recordTurnMessage, takeTurnMessage, type BufferedTurnMessage } from './turn-buffer';
import { useDmNotifications, type DmAssistantMessage } from './useDmNotifications';
import { useSystemNotices, type SystemNoticeMessage } from './useSystemNotices';

interface DirectEntry {
  name: string | null;
  projectId: string | null;
}

interface DirectLookup {
  map: Map<string, DirectEntry>;
  refresh: () => Promise<Map<string, DirectEntry> | null>;
}

type DirectSession = Pick<SessionInfo, 'sessionId' | 'label' | 'name' | 'projectId'>;
type Deliver = (item: NotificationItem) => void;
type NextId = (prefix: 'dmn' | 'sysn') => string;

export interface UseNotificationFeedOptions {
  isSessionOpen: (sessionId: string) => boolean;
  /** In-app sink for an item that was not delivered externally — pushes onto the shared bubble
   *  queue (design/Toast). The feed owns no list of its own; one queue renders every bubble. */
  publish: (item: NotificationItem) => void;
  externalDelivery?: (item: NotificationItem) => Promise<boolean>;
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

function useDirectLookup(): DirectLookup {
  const trpc = useTRPC();
  const query = useQuery(trpc.sessions.list.queryOptions({ origin: 'direct' }));
  const map = useMemo(() => toDirectMap(query.data), [query.data]);
  const refresh = useCallback(async () => {
    const result = await query.refetch();
    return result.isError ? null : toDirectMap(result.data);
  }, [query.refetch]);
  return { map, refresh };
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
  publish: UseNotificationFeedOptions['publish'],
  externalDelivery: UseNotificationFeedOptions['externalDelivery'],
): Deliver {
  const mounted = useMountedRef();
  const publishRef = useRef(publish);
  publishRef.current = publish;
  return useCallback((item: NotificationItem) => {
    void (async () => {
      try {
        if (externalDelivery && await externalDelivery(item)) return;
      } catch {
        // External delivery is best-effort; rejection takes the same in-app fallback as false.
      }
      if (mounted.current) publishRef.current(item);
    })();
  }, [externalDelivery, mounted]);
}

interface DmConsumption {
  consumed: boolean;
  item: NotificationItem | null;
}

function consumeDmTurn(
  buffer: Map<string, BufferedTurnMessage>, directMap: Map<string, DirectEntry>,
  isSessionOpen: (sessionId: string) => boolean, nextId: NextId, sessionId: string,
): DmConsumption {
  if (!buffer.has(sessionId)) return { consumed: true, item: null };
  if (isSessionOpen(sessionId)) {
    takeTurnMessage(buffer, sessionId);
    return { consumed: true, item: null };
  }
  const entry = directMap.get(sessionId);
  if (!entry) return { consumed: false, item: null };
  const message = takeTurnMessage(buffer, sessionId)!;
  return { consumed: true, item: buildNotification({
    id: nextId('dmn'), sessionId, sessionName: entry.name,
    projectId: entry.projectId, text: message.text, ts: message.ts,
  }) };
}

function useDmFeed(lookup: DirectLookup, isSessionOpen: (sessionId: string) => boolean,
  nextId: NextId, deliver: Deliver): void {
  const buffer = useRef<Map<string, BufferedTurnMessage>>(new Map());
  const pendingEnds = useRef(new Set<string>());
  const flush = useCallback((sessionId: string, map = lookup.map) => {
    const result = consumeDmTurn(buffer.current, map, isSessionOpen, nextId, sessionId);
    if (!result.consumed) return false;
    pendingEnds.current.delete(sessionId);
    if (result.item) deliver(result.item);
    return true;
  }, [deliver, isSessionOpen, lookup.map, nextId]);
  const onMessage = useCallback((message: DmAssistantMessage) => {
    recordTurnMessage(buffer.current, message.sessionId, {
      text: message.text, ts: message.ts ?? new Date().toISOString(),
    });
  }, []);
  const onTurnEnd = useCallback((sessionId: string) => {
    if (!buffer.current.has(sessionId) || flush(sessionId)) return;
    pendingEnds.current.add(sessionId);
    void lookup.refresh().then((map) => {
      if (!map || flush(sessionId, map)) return;
      takeTurnMessage(buffer.current, sessionId);
      pendingEnds.current.delete(sessionId);
    }).catch(() => undefined);
  }, [flush, lookup]);
  useEffect(() => { pendingEnds.current.forEach((sessionId) => { flush(sessionId); }); }, [flush]);
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
  publish,
  externalDelivery,
}: UseNotificationFeedOptions): void {
  const counter = useRef(0);
  const directLookup = useDirectLookup();
  const deliver = useDelivery(publish, externalDelivery);
  const nextId = useCallback<NextId>((prefix) => `${prefix}-${counter.current++}`, []);
  useDmFeed(directLookup, isSessionOpen, nextId, deliver);
  useNoticeFeed(nextId, deliver);
}
