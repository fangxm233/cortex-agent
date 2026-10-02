interface TitledSession {
  label: string | null;
  name: string;
  labelRenamed?: boolean;
}

export function sessionDisplayTitle(session: TitledSession, runTitle: string | null): string {
  if (session.labelRenamed && session.label) return session.label;
  return runTitle ?? session.label ?? session.name;
}
