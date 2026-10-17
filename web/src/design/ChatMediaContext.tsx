import { createContext, useContext, type ComponentType } from 'react';

export interface ChatMediaMessage {
  sessionId: string;
  ts?: string;
}

export interface ChatMediaProps extends ChatMediaMessage {
  src: string;
  alt: string;
}

export const ChatMediaContext = createContext<(ChatMediaMessage & { Media: ComponentType<ChatMediaProps> }) | null>(null);

export function ChatMarkdownMedia({ src, alt }: { src: string; alt: string }): JSX.Element {
  const context = useContext(ChatMediaContext);
  if (!context) return <>{alt || src}</>;
  const { Media, sessionId, ts } = context;
  return <Media key={`${sessionId}:${ts ?? ''}:${src}`} sessionId={sessionId} ts={ts} src={src} alt={alt} />;
}
