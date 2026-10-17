import { useEffect, useState } from 'react';
import { useTRPCClient } from '@/lib/trpc';
import type { ChatMediaProps } from '@/design/ChatMediaContext';
import type { MediaItem } from './preview-item';

export type InlineMediaError = 'offline' | 'not_found' | 'unsupported' | 'too_large' | 'load_failed';
interface MediaResource {
  item?: MediaItem;
  error?: InlineMediaError;
}

export function useInlineMediaResource({ sessionId, ts, src }: ChatMediaProps, enabled: boolean): MediaResource {
  const client = useTRPCClient();
  const [state, setState] = useState<MediaResource>({});
  useEffect(() => {
    if (!enabled || !ts) return;
    let alive = true;
    client.sessions.resolveMedia.mutate({ sessionId, ts, src })
      .then((result) => {
        if (!alive) return;
        setState('error' in result ? { error: result.error.code } : { item: result });
      })
      .catch(() => { if (alive) setState({ error: 'load_failed' }); });
    return () => { alive = false; };
  }, [client, sessionId, ts, src, enabled]);
  return state;
}
