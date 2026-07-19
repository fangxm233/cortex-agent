// Pure VM for the "Session ID" surface (desktop ChatHeader ⋯ menu + mobile ⋯ menu). A session carries
// two identifiers: the human-facing Cortex ID (the cortex-XXXX short name, SessionInfo.name) and the
// backend UUID — the backend CLI resume target (SessionInfo.backendSessionId). Since the track/backend
// id decoupling, the backend UUID is NO LONGER SessionInfo.sessionId (that is now the stable track id);
// feeding sessionId here showed the wrong id. This builds the label/value rows both platforms render,
// with a neutral dash fallback when an id is missing (never fabricated — a fresh session has no
// backend id until its first turn completes).

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
