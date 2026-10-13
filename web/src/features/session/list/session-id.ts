// Shared ID rows: stable session ID and backend resume ID.

export interface SessionIdRow {
  key: 'sessionId' | 'backendUuid';
  label: string;
  value: string;
}

const DASH = '—';

export function buildSessionIdRows(opts: {
  sessionId: string | null | undefined;
  backendUuid: string | null | undefined;
  sessionIdLabel: string;
  backendUuidLabel: string;
}): SessionIdRow[] {
  return [
    { key: 'sessionId', label: opts.sessionIdLabel, value: opts.sessionId?.trim() || DASH },
    { key: 'backendUuid', label: opts.backendUuidLabel, value: opts.backendUuid?.trim() || DASH },
  ];
}
