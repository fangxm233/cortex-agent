import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';

const MARK_READ_DEBOUNCE_MS = 800;

/**
 * Unread tracking write side: stamp the OPEN session read (`sessions.markRead` → registry
 * lastReadAt) whenever the user is actually looking at it, so `SessionInfo.unread`
 * (= lastUsedAt > lastReadAt) only flags activity that landed while they were away.
 *
 * Fires (debounced, only while `document.visibilityState === 'visible'`):
 *  • on session select / mount;
 *  • on live activity while viewing (`activitySignal` — liveTail length + running edge), so the
 *    turn-end lastUsedAt bump never leaves the currently-open session marked unread;
 *  • on the tab becoming visible again (returning to a backgrounded tab = reading it now).
 * On success, invalidates sessions.list so the unread highlight clears everywhere.
 */
export function useMarkSessionRead(sessionId: string, activitySignal: unknown): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const markRead = useMutation(
    trpc.sessions.markRead.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
      },
    }),
  );
  // Keep the latest mutate in a ref so effects don't re-run on mutation identity changes.
  const mutateRef = useRef(markRead.mutate);
  mutateRef.current = markRead.mutate;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    const fire = () => {
      if (document.visibilityState !== 'visible') return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        mutateRef.current({ sessionId });
      }, MARK_READ_DEBOUNCE_MS);
    };

    fire();
    const onVisible = () => {
      if (document.visibilityState === 'visible') fire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
    // activitySignal re-arms the debounce on live events while viewing.
  }, [sessionId, activitySignal]);
}
