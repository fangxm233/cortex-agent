// input:  direct tRPC client and config query cache
// output: serialized platform/runtime writes and safe feedback
// pos:    Shared write owner without credential mutation caching
// >>> Once updated, update this header and parent CORTEX.md <<<

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PlatformSettingsPatch } from '@cortex-agent/ui-contract';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import type { PlatformRuntimePatch } from './PlatformRuntimeFields';

export type PlatformWriteFeedback = 'saved' | 'runtimeSaved' | 'failed' | 'refreshFailed' | null;
export function usePlatformSettings() {
  const client = useTRPCClient();
  const trpc = useTRPC();
  const cache = useQueryClient();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<PlatformWriteFeedback>(null);
  const commit = useCallback(async (write: () => Promise<unknown>, success: PlatformWriteFeedback) => {
    if (busy.current) return false;
    busy.current = true; setPending(true); setFeedback(null);
    let saved = false;
    try {
      await write(); saved = true; setFeedback(success);
      await cache.invalidateQueries(trpc.config.get.queryFilter({}), { throwOnError: true });
    } catch { setFeedback(saved ? 'refreshFailed' : 'failed'); }
    finally { busy.current = false; setPending(false); }
    return saved;
  }, [cache, trpc]);
  // The server emits declarations without strictNullChecks; casts preserve schema-validated null clears.
  // Direct client calls deliberately avoid useMutation: its cache retains variables (secrets).
  const saveConnection = (patch: PlatformSettingsPatch) => commit(() => client.config.setPlatform.mutate(
    patch as unknown as Parameters<typeof client.config.setPlatform.mutate>[0],
  ), 'saved');
  const saveRuntime = (value: PlatformRuntimePatch) => commit(() => client.config.set.mutate(
    { section: 'settings', value } as unknown as Parameters<typeof client.config.set.mutate>[0],
  ), 'runtimeSaved');
  return { pending, feedback, saveConnection, saveRuntime };
}
