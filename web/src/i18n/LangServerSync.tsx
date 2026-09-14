// input:  config.get snapshot (lang + provenance), config.set mutation, LangProvider's sync seam
// output: a render-nothing component that makes the server the source of truth for the language
// pos:    The bridge between the server's one language knob and the SPA's vocabulary. Mounted once,
//         inside <LangProvider> and inside the tRPC/react-query providers.

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLangSync } from './LangProvider';

/**
 * Why a separate component instead of doing this inside LangProvider: LangProvider is rendered bare
 * (no QueryClient, no tRPC) by isolated component tests, and `useQuery` would throw there. Keeping
 * the network half here lets the provider stay dependency-free and degrade to its local cache.
 *
 * An older server omits `lang` from the snapshot; we then leave the cached value alone rather than
 * forcing a default over the user's choice.
 */
export function LangServerSync(): null {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const sync = useLangSync();
  const config = useQuery(trpc.config.get.queryOptions({}));
  const write = useMutation(trpc.config.set.mutationOptions({
    // Always refetch, success or failure. On success it re-renders every other surface holding
    // this snapshot; on failure it is what undoes the optimistic toggle, because the server — which
    // never changed — gets the last word.
    onSettled: () => queryClient.invalidateQueries(trpc.config.get.queryFilter({})),
  }));

  // Read through a ref rather than an effect dependency: keying the adopt effect on `isPending`
  // would fire it the moment a write settles, while the refetch is still in flight, and briefly
  // re-adopt the PRE-write language — a visible flicker back to the old one.
  const writePending = useRef(false);
  writePending.current = write.isPending;

  const serverLang = config.data?.lang;
  const adopt = sync?.adopt;
  const fetchedAt = config.dataUpdatedAt;
  useEffect(() => {
    if (!adopt || !serverLang) return;
    // A write is in flight: its own post-write refetch will adopt, with the newer value.
    if (writePending.current) return;
    adopt(serverLang.value, serverLang.source);
    // `fetchedAt` is in here on purpose: EVERY successful fetch must re-assert the server's value,
    // not just one that changed it. That is what rolls an optimistic toggle back when its write
    // failed — the snapshot then comes back identical, and identity is exactly the correction.
  }, [adopt, serverLang?.value, serverLang?.source, fetchedAt]);

  const setWriter = sync?.setWriter;
  const mutate = write.mutate;
  useEffect(() => {
    if (!setWriter) return;
    setWriter((lang) => { mutate({ section: 'preferences', value: { lang } }); });
    return () => setWriter(null);
  }, [setWriter, mutate]);

  return null;
}
