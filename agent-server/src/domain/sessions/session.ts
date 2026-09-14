import { sessionRepo } from '@store/session-repo.js';

// A channel has ONE session; the backend it runs is on the session record. `backend` is
// accepted and ignored here so call sites migrate one at a time.

export async function getSessionAsync(channel: string, backend?: string): Promise<string | undefined> {
  return sessionRepo.getSessionAsync(channel, backend);
}

export async function setSessionAsync(channel: string, sessionId: string, backend?: string): Promise<void> {
  return sessionRepo.setSessionAsync(channel, sessionId, backend);
}

export async function deleteSessionAsync(channel: string, backend?: string): Promise<void> {
  return sessionRepo.deleteSessionAsync(channel, backend);
}
