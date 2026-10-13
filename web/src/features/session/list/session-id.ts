// Shared ID rows: display name, stable transcript session ID, and backend resume ID.

export interface SessionIdRow {
  key: 'cortexId' | 'sessionId' | 'backendUuid';
  label: string;
  value: string;
}

const DASH = '—';

export function buildSessionIdRows(opts: {
  cortexId: string | null | undefined;
  sessionId: string | null | undefined;
  backendUuid: string | null | undefined;
  cortexIdLabel: string;
  sessionIdLabel: string;
  backendUuidLabel: string;
}): SessionIdRow[] {
  return [
    { key: 'cortexId', label: opts.cortexIdLabel, value: opts.cortexId?.trim() || DASH },
    { key: 'sessionId', label: opts.sessionIdLabel, value: opts.sessionId?.trim() || DASH },
    { key: 'backendUuid', label: opts.backendUuidLabel, value: opts.backendUuid?.trim() || DASH },
  ];
}
