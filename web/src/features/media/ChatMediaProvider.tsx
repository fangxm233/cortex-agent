import { useMemo, useState, type ReactNode } from 'react';
import { ChatMediaContext } from '@/design/ChatMediaContext';
import { InlineMedia } from './InlineMedia';
import { createMediaGroup, MediaGroupProvider } from './inline-media-group';

export function ChatMediaProvider({ sessionId, ts, children }: {
  sessionId?: string;
  ts?: string;
  children: ReactNode;
}): JSX.Element {
  const value = useMemo(() => sessionId ? { sessionId, ts, Media: InlineMedia } : null, [sessionId, ts]);
  const [group] = useState(createMediaGroup);
  return (
    <ChatMediaContext.Provider value={value}>
      <MediaGroupProvider value={group}>{children}</MediaGroupProvider>
    </ChatMediaContext.Provider>
  );
}
