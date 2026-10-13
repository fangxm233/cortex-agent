import { shortSessionId } from './short-session-id';

interface TitledSession {
  label: string | null;
  sessionId: string;
  labelRenamed?: boolean;
}

export function sessionDisplayTitle(session: TitledSession, runTitle: string | null): string {
  if (session.labelRenamed && session.label) return session.label;
  return runTitle ?? session.label ?? shortSessionId(session.sessionId);
}
