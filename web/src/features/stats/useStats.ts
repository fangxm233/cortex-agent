import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  StatsQuotaWindows, StatsRange, StatsToolKind, StatsTools, StatsUsage,
} from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { DEFAULT_STATS_RANGE } from './stats-vm';

/** One read of the page. `refreshing` is true while a refetch shows the previous result. */
export interface StatsQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  error: { message: string } | null;
  refreshing: boolean;
}

export interface StatsAccountRef {
  provider: string;
  route: string | null;
}

/** The page's filters and its three reads. Range, project and page scope usage and tools alike. */
export interface StatsController {
  range: StatsRange;
  setRange: (range: StatsRange) => void;
  projectId: string | null;
  setProjectId: (projectId: string | null) => void;
  page: number;
  setPage: (page: number) => void;
  toolKind: StatsToolKind;
  setToolKind: (kind: StatsToolKind) => void;
  setAccount: (account: StatsAccountRef) => void;
  usage: StatsQuery<StatsUsage>;
  tools: StatsQuery<StatsTools>;
  quota: StatsQuery<StatsQuotaWindows>;
  /** Epoch ms, ticking once a minute for the "last active" column. */
  now: number;
}

// The tool index builds in the background on first use; poll until it reports ready.
const TOOLS_INDEX_POLL_MS = 3_000;
const NOW_TICK_MS = 60_000;

interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  error: { message: string } | null;
  isPlaceholderData: boolean;
  isFetching: boolean;
}

function readQuery<T>(query: QueryLike<T>): StatsQuery<T> {
  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error ? { message: query.error.message } : null,
    refreshing: query.isPlaceholderData && query.isFetching,
  };
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function useStatsController(): StatsController {
  const trpc = useTRPC();
  const [range, setRangeState] = useState<StatsRange>(DEFAULT_STATS_RANGE);
  const [projectId, setProjectState] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [toolKind, setToolKind] = useState<StatsToolKind>('tool');
  const [account, setAccount] = useState<StatsAccountRef | null>(null);
  const scope = { range, page, ...(projectId ? { projectId } : {}) };
  const usage = useQuery({ ...trpc.stats.usage.queryOptions(scope), placeholderData: keepPreviousData });
  const tools = useQuery({
    ...trpc.stats.tools.queryOptions({ ...scope, kind: toolKind }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.ready === false ? TOOLS_INDEX_POLL_MS : false),
  });
  const quota = useQuery({
    // A missing route is the provider's default login.
    ...trpc.stats.quotaWindows.queryOptions(account
      ? { provider: account.provider, ...(account.route ? { route: account.route } : {}) }
      : {}),
    placeholderData: keepPreviousData,
  });
  const now = useNow();
  return {
    range,
    setRange: (next) => { setRangeState(next); setPage(0); },
    projectId,
    setProjectId: (next) => { setProjectState(next); setPage(0); },
    page,
    setPage,
    toolKind,
    setToolKind,
    setAccount,
    usage: readQuery(usage as QueryLike<StatsUsage>),
    tools: readQuery(tools as QueryLike<StatsTools>),
    quota: readQuery(quota as QueryLike<StatsQuotaWindows>),
    now,
  };
}
