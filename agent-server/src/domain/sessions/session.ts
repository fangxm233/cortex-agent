import { sessionStore } from '@store/session-registry-repo.js';

// A channel has ONE session; the backend it runs is on the session record. `backend` is
// accepted and ignored here so call sites migrate one at a time. These are thin wrappers over the
// session registry's channel bindings — the registry is the single owner of channel→session identity.

export async function getSessionAsync(channel: string, backend?: string): Promise<string | undefined> {
  return (await sessionStore.getBoundSessionId(channel)) ?? undefined;
}

export async function setSessionAsync(channel: string, sessionId: string, backend?: string): Promise<void> {
  await sessionStore.bindChannel(channel, sessionId);
}

export async function deleteSessionAsync(channel: string, backend?: string): Promise<void> {
  await sessionStore.unbindChannel(channel);
}
