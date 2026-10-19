import { apiBase, authHeaders } from '@/lib/desktop-config';

// The agent's browser over the ui-http routes (agent-server platform/ui-http/browser-stream.ts):
// which sessions hold one, the live stream, and the person's takeover of it.

export type AgentBrowserState = 'starting' | 'ready' | 'error';

export interface AgentBrowserSession {
  sessionId: string;
  device: string;
  state: AgentBrowserState;
  error?: string;
  url?: string;
  title?: string;
  takenOver: boolean;
  lastUsedAt: number;
}

/** A failed call, by the stable `code` the server answers with (or the HTTP status). */
export class AgentBrowserError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  // A server without these routes answers the SPA's index.html: treat it like any other failure.
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; code?: string; message?: string };
  if (!res.ok || !body.ok) throw new AgentBrowserError(body.code ?? `http-${res.status}`, body.message ?? `HTTP ${res.status}`, res.status);
  return body.data as T;
}

export async function listAgentBrowsers(): Promise<AgentBrowserSession[]> {
  const data = await call<{ sessions?: AgentBrowserSession[] }>('/api/browser/sessions', { cache: 'no-store' });
  return data.sessions ?? [];
}

export async function mintStreamTicket(sessionId: string): Promise<string> {
  const data = await call<{ ticket: string }>('/api/browser/stream-ticket', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId }),
  });
  return data.ticket;
}

export async function setAgentBrowserTakeover(sessionId: string, on: boolean): Promise<boolean> {
  const data = await call<{ takenOver: boolean }>('/api/browser/takeover', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId, on }),
  });
  return data.takenOver;
}

export async function insertAgentBrowserText(sessionId: string, text: string): Promise<void> {
  await call<unknown>('/api/browser/insert-text', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId, text }),
  });
}

/**
 * The stream's WebSocket URL. A native shell talks to the configured server; a browser page to its
 * own origin (the dev server proxies it on).
 */
export function streamSocketUrl(sessionId: string, ticket: string, maxFps: number, base = apiBase(), pageUrl = globalThis.location?.href ?? 'http://localhost/'): string {
  const url = base ? new URL(`${base.replace(/\/+$/, '')}/api/browser/stream`) : new URL('/api/browser/stream', pageUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams({ session: sessionId, ticket, maxFps: String(maxFps) }).toString();
  return url.toString();
}
