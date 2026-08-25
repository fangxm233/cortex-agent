// input:  the Tauri shell bridge and the server's listening-port route
// output: port-forward lifecycle calls and the remote listening-port list
// pos:    browser pane transport layer; the only module that knows the forward exists
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { apiBase, authHeaders, isDesktopShell } from '@/lib/desktop-config';

// The forward lives in the native shell (desktop/src-tauri/src/forward.rs): it binds a REAL local
// port and relays each connection to the server's `/forward` WebSocket, which connects to its own
// loopback. That is what makes a remote dev server previewable — see plan/embedded-browser.md §4.
// Accessed through the `window.__TAURI__` global (the shell sets `withGlobalTauri: true`), matching
// lib/files.ts; no `@tauri-apps/api` dependency is added.

interface TauriCore {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

function tauriCore(): TauriCore | undefined {
  return (globalThis as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core;
}

export interface ForwardInfo {
  remotePort: number;
  localPort: number;
  /** Ready-to-open local URL. */
  url: string;
}

export interface ListeningPort {
  port: number;
  address: string;
  process: string | null;
}

/** True when a forward can be established at all (native shell with the command available). */
export function canForward(): boolean {
  return isDesktopShell() && !!tauriCore();
}

/** Start (or reuse) the forward for a server-side port. Idempotent on the Rust side. */
export async function startForward(port: number): Promise<ForwardInfo> {
  const core = tauriCore();
  if (!core) throw new Error('Port forwarding needs the desktop app.');
  return core.invoke<ForwardInfo>('forward_start', { port });
}

export async function stopForward(port: number): Promise<void> {
  await tauriCore()?.invoke('forward_stop', { port });
}

export async function listForwards(): Promise<ForwardInfo[]> {
  const core = tauriCore();
  if (!core) return [];
  return core.invoke<ForwardInfo[]>('forward_list');
}

/**
 * Ports currently listening on the SERVER's loopback. Authenticated like every other non-tRPC
 * route; an empty list is a normal answer (no `ss`, nothing listening), not an error.
 */
export async function listRemotePorts(): Promise<ListeningPort[]> {
  const res = await fetch(`${apiBase()}/api/forward/ports`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Could not list server ports (${res.status})`);
  const body = (await res.json()) as { ok?: boolean; data?: { ports?: ListeningPort[] } };
  return body.data?.ports ?? [];
}

// ── Ports on other machines ───────────────────────────────────────────────────
// A device runs cortex-client, which is outbound-only, so nothing here dials INTO it. The server
// asks the device over its existing control socket to dial back, and hands us a plain loopback port
// on the server (plan/embedded-browser.md §18). From this side a device port is therefore just a
// server port — the desktop forward above tunnels it the rest of the way unchanged.

export interface ForwardDevice {
  device: string;
  platform: string;
}

export interface DevicePortMapping {
  device: string;
  remoteHost: string;
  remotePort: number;
  /** Port on the SERVER. Feed it to `startForward` to reach it from this machine. */
  localPort: number;
}

async function forwardApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body.data as T;
}

/** Devices currently connected to the server. Empty is normal — most setups have none. */
export async function listForwardDevices(): Promise<ForwardDevice[]> {
  const data = await forwardApi<{ devices: ForwardDevice[] }>('/api/forward/devices');
  return data.devices ?? [];
}

/** Ports listening on one device's loopback. */
export async function listDeviceRemotePorts(device: string): Promise<ListeningPort[]> {
  const data = await forwardApi<{ ports: ListeningPort[] }>(
    `/api/forward/device-ports?device=${encodeURIComponent(device)}`,
  );
  return data.ports ?? [];
}

/** Map a device port onto a server port. Idempotent per (device, port) on the server side. */
export async function openDeviceForward(device: string, port: number): Promise<DevicePortMapping> {
  return forwardApi<DevicePortMapping>('/api/forward/device-port', {
    method: 'POST',
    body: JSON.stringify({ device, port }),
  });
}
