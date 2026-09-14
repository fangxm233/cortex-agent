import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SystemNoticeEntry } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useSystemNotices } from './useSystemNotices';

// Read side of the server's system-notice ring (agent-server domain/system/notice-history.ts):
// the notices that were fanned out to the admin channels (startup/restart, config & profile
// hot-reload, disk, rate limit, auth expiry, job summaries). In-memory on the server, so the list
// starts empty after a restart — the restart notice itself is then the first entry.
//
// Refreshed by the live `system.notice` event rather than polling: the same event that raises the
// toast invalidates this query, so an open Settings panel stays current at zero idle cost.

/** How many entries the Settings card asks for (the server ring holds up to `cap`). */
export const NOTICE_HISTORY_LIMIT = 20;

export interface NoticeHistory {
  entries: SystemNoticeEntry[];
  /** Server-side ring capacity, for honest labelling. */
  cap: number;
  loading: boolean;
  error: boolean;
}

export function useNoticeHistory(limit: number = NOTICE_HISTORY_LIMIT): NoticeHistory {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const options = trpc.system.notices.queryOptions({ limit });
  const query = useQuery(options);
  const queryKey = options.queryKey;

  useSystemNotices(useCallback(() => {
    void queryClient.invalidateQueries({ queryKey, exact: true });
  }, [queryClient, queryKey]));

  return {
    entries: query.data?.entries ?? [],
    cap: query.data?.cap ?? 0,
    loading: query.isLoading,
    error: query.isError,
  };
}
