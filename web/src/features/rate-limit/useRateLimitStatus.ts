// input:  system.rateLimitStatus query, shared rate-limit events, reconnect epoch, language
// output: locally ticking active-only RateLimitView or null
// pos:    Query/live-sync owner shared by desktop rail and mobile Projects screen
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { useLiveConnection, useLiveEvents } from '@/features/live/LiveEventsProvider';
import { RATE_LIMIT_LIVE_EVENTS } from '@/features/live/live-events';
import { buildRateLimitView, type RateLimitView } from './rate-limit-vm';

function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function useRateLimitStatus(): RateLimitView | null {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const lang = useLang();
  const query = useQuery(trpc.system.rateLimitStatus.queryOptions({}));
  const { reconnectEpoch } = useLiveConnection();
  const [nowSec, setNowSec] = useState(currentEpochSeconds);

  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.system.rateLimitStatus.queryFilter());
  };
  useLiveEvents(RATE_LIMIT_LIVE_EVENTS, invalidate);

  useEffect(() => {
    if (reconnectEpoch > 0) invalidate();
  }, [reconnectEpoch]);

  const active = (query.data?.providers.length ?? 0) > 0;
  useEffect(() => {
    if (!active) return;
    setNowSec(currentEpochSeconds());
    const timer = window.setInterval(() => setNowSec(currentEpochSeconds()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);

  return buildRateLimitView(query.data, nowSec, lang);
}
