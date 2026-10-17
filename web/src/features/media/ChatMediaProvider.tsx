import { useMemo, type ReactNode } from 'react';
import { ChatMediaContext } from '@/design/ChatMediaContext';
import { InlineMedia } from './InlineMedia';

export function ChatMediaProvider({ sessionId, ts, children }: {
  sessionId?: string;
  ts?: string;
  children: ReactNode;
}): JSX.Element {
  const value = useMemo(() => sessionId ? { sessionId, ts, Media: InlineMedia } : null, [sessionId, ts]);
  return <ChatMediaContext.Provider value={value}>{children}</ChatMediaContext.Provider>;
}
