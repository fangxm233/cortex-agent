// input:  sessions.json file, channel ID
// output: { getSessionAsync, setSessionAsync, deleteSessionAsync } — channel session CRUD
// pos:    thin re-export layer, all session CRUD goes through store/session-repo.ts (AsyncMutex serialization)
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { sessionRepo } from '@store/session-repo.js';

// P3.2: a channel has ONE session; the backend it runs is on the session record. `backend` is
// accepted and ignored here so call sites migrate one at a time — Phase 4 drops the parameter.

export async function getSessionAsync(channel: string, backend?: string): Promise<string | undefined> {
  return sessionRepo.getSessionAsync(channel, backend);
}

export async function setSessionAsync(channel: string, sessionId: string, backend?: string): Promise<void> {
  return sessionRepo.setSessionAsync(channel, sessionId, backend);
}

export async function deleteSessionAsync(channel: string, backend?: string): Promise<void> {
  return sessionRepo.deleteSessionAsync(channel, backend);
}
