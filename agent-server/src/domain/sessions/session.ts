import { sessionStore } from '@store/session-registry-repo.js';

// A channel has ONE session; the backend it runs is on the session record. These are thin wrappers
// over the session registry's channel bindings — the registry is the single owner of
// channel→session identity.

export async function getSessionAsync(channel: string): Promise<string | undefined> {
  return (await sessionStore.getBoundSessionId(channel)) ?? undefined;
}

export async function setSessionAsync(channel: string, sessionId: string): Promise<void> {
  await sessionStore.bindChannel(channel, sessionId);
}

export async function deleteSessionAsync(channel: string): Promise<void> {
  await sessionStore.unbindChannel(channel);
}
