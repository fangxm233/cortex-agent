import { readFileSync } from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from '@core/paths.js';

// Read machines.json directly instead of importing machine-registry: that module loads and logs at
// import time, and a stdio sidecar must keep stdout clean for the MCP protocol.
const MACHINES_FILE = path.join(CONFIG_DIR, 'machines.json');

export interface KnownDevice {
  name: string;
  windows: boolean;
}

/** Every registered machine, online or not. A missing or unreadable file yields none. */
export function readKnownDevices(file: string = MACHINES_FILE): KnownDevice[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, { win?: unknown } | null>;
    return Object.entries(parsed).map(([name, entry]) => ({ name, windows: entry?.win === true }));
  } catch {
    return [];
  }
}

export function deviceParamDescription(devices: readonly KnownDevice[]): string {
  if (devices.length === 0) return 'Target device name';
  const names = devices.map(d => (d.windows ? `${d.name} (Windows)` : d.name)).join(', ');
  return `Target device name. Known devices: ${names}. A device may be offline; calling an offline one fails and lists the devices online at that moment.`;
}

/** Append the daemon's online-device list to a failed remote call's error. */
export function withOnlineDevices(message: string, online: unknown): string {
  if (!Array.isArray(online)) return message;
  return `${message}. Online devices: ${online.length > 0 ? online.join(', ') : 'none'}`;
}
