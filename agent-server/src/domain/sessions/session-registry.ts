// input:  session-registry.jsonl + session metadata
// output: thin re-export — all functionality delegated to store/session-registry-repo.ts
// pos:    cortex-XXXX short name ↔ session UUID registry (thin re-export layer)
// TODO: S12 — delete this file after physical move to store/ directory.
//       All callers in src/ have been migrated to store/session-registry-repo.ts.
//       This file is kept only so any external tooling that still imports this path
//       continues to compile until the S12 git-mv sweep.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { sessionStore, type SessionOrigin } from '@store/session-registry-repo.js';
export { sessionStore, sessionRegistryRepo, type Session, type SessionOrigin, type SessionRegistryData } from '@store/session-registry-repo.js';

export function generateSessionName(): Promise<string> {
  return sessionStore.generateSessionName();
}

export function registerSession(name: string, opts: { sessionId: string; channel: string; backend: string; kind: 'local' | 'scheduled'; origin?: SessionOrigin; projectId?: string; label?: string | null; profileName?: string | null }): Promise<void> {
  return sessionStore.registerSession(name, opts);
}

export function updateSession(name: string, updates: {
  lastUsedAt?: string;
  label?: string | null;
  profileName?: string | null;
  backendSessionId?: string | null;
}): Promise<void> {
  return sessionStore.updateSession(name, updates);
}

export function lookupSession(name: string) {
  return sessionStore.lookupSession(name);
}

export function lookupBySessionId(sessionId: string) {
  return sessionStore.lookupBySessionId(sessionId);
}

export function listRecentSessions(limit = 10) {
  return sessionStore.listRecentSessions(limit);
}

export function getActiveSessionName(channel: string, backend: string) {
  return sessionStore.getActiveSessionName(channel, backend);
}

export function getById(sessionId: string) {
  return sessionStore.getById(sessionId);
}

export function listByProject(projectId: string) {
  return sessionStore.listByProject(projectId);
}

export function listResumable(projectId?: string) {
  return sessionStore.listResumable(projectId);
}

export function markUsed(sessionId: string): Promise<void> {
  return sessionStore.markUsed(sessionId);
}

export function pruneStale(maxAgeMs: number): Promise<number> {
  return sessionStore.pruneStale(maxAgeMs);
}
