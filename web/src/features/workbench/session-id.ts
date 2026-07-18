// Pure VM for the "Session ID" surface (desktop ChatHeader ⋯ menu + mobile ⋯ menu). A session carries
// two identifiers: the human-facing Cortex ID (the cortex-XXXX short name, SessionInfo.name) and the
// backend UUID (SessionInfo.sessionId, a crypto.randomUUID()). This builds the label/value rows both
// platforms render, with a neutral dash fallback when an id is missing (never fabricated).

export interface SessionIdRow {
  key: 'cortexId' | 'backendUuid';
  label: string;
  value: string;
}

const DASH = '—';

export function buildSessionIdRows(opts: {
  cortexId: string | null | undefined;
  backendUuid: string | null | undefined;
  cortexIdLabel: string;
  backendUuidLabel: string;
}): SessionIdRow[] {
  return [
    { key: 'cortexId', label: opts.cortexIdLabel, value: opts.cortexId?.trim() || DASH },
    { key: 'backendUuid', label: opts.backendUuidLabel, value: opts.backendUuid?.trim() || DASH },
  ];
}
