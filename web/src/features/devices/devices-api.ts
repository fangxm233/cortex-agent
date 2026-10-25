// Paired apps and pairing codes (server: agent-server/src/platform/ui-http/ui-device-routes.ts).
import { apiBase, authHeaders } from '@/lib/desktop-config';

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  /** The app making this request. */
  current: boolean;
}

export interface PairedDevicesSnapshot {
  devices: PairedDevice[];
  /** The server mints codes (browser token login is on). */
  pairing: boolean;
}

export interface MintedPairingCode {
  code: string;
  expiresAt: number;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  // A server without these routes answers its SPA page: treat it as a failure, not as data.
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; message?: string };
  if (!res.ok || !body.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
  return body.data as T;
}

export function fetchPairedDevices(): Promise<PairedDevicesSnapshot> {
  return call('/api/ui/devices');
}

export function createPairingCode(): Promise<MintedPairingCode> {
  return call('/api/ui/pairing-code', { method: 'POST' });
}

export async function revokePairedDevice(id: string): Promise<void> {
  await call('/api/ui/devices/revoke', { method: 'POST', body: JSON.stringify({ id }) });
}
