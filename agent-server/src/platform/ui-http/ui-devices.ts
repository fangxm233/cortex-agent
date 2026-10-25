// Per-device app tokens. A desktop or mobile app that pairs with a code gets its own token, sent as
// `x-cortex-token` exactly like the shared client token, so the app needs no other change. Each one
// can be revoked alone; the shared client token stays with cortex-client devices.
//
// Only a SHA-256 of each token is stored. The server is the only writer, so the file is read once.

import * as crypto from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';
import { timingSafeEqualStr } from '@core/auth.js';
import { createLogger } from '@core/log.js';

const log = createLogger('ui-http');

/** Last-use times move on every request; disk sees them at most this often per device. */
export const DEVICE_SEEN_PERSIST_MS = 10 * 60 * 1000;

const NAME_MAX = 60;
const NAME_FALLBACK = 'App';

export interface UiDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface UiDeviceStore {
  /** Register a device and return its token. The token is never retrievable again. */
  issue(name: string): { device: UiDevice; token: string };
  /** The device a presented token belongs to, recording the use. */
  match(token: string | undefined): UiDevice | undefined;
  list(): UiDevice[];
  /** False when no such device exists. */
  revoke(id: string): boolean;
}

interface StoredDevice extends UiDevice {
  tokenHash: string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cleanName(name: string): string {
  const trimmed = name.trim().slice(0, NAME_MAX);
  return trimmed || NAME_FALLBACK;
}

function isStoredDevice(value: unknown): value is StoredDevice {
  const d = value as Partial<StoredDevice> | null;
  return typeof d?.id === 'string' && typeof d.name === 'string' && typeof d.tokenHash === 'string'
    && typeof d.createdAt === 'number' && typeof d.lastSeenAt === 'number';
}

function load(file: string | undefined): StoredDevice[] {
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { devices?: unknown };
    return Array.isArray(parsed?.devices) ? parsed.devices.filter(isStoredDevice) : [];
  } catch {
    return []; // absent or corrupt → no paired devices; the apps pair again
  }
}

function publicView(d: StoredDevice): UiDevice {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
}

export function createUiDeviceStore(opts: { file?: string; now?: () => number } = {}): UiDeviceStore {
  const now = opts.now ?? (() => Date.now());
  const devices = load(opts.file);
  /** lastSeenAt as last written, per device id. */
  const persistedSeen = new Map(devices.map((d) => [d.id, d.lastSeenAt]));

  const persist = (): void => {
    if (!opts.file) return;
    try {
      mkdirSync(path.dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ devices }), { mode: 0o600 });
      renameSync(tmp, opts.file);
      for (const d of devices) persistedSeen.set(d.id, d.lastSeenAt);
    } catch (e) {
      log.warn(`could not persist paired devices: ${(e as Error).message}`);
    }
  };

  // Constant-time walk over every hash, as the session store does: the set is a handful of apps.
  const find = (token: string): StoredDevice | undefined => {
    const hash = hashToken(token);
    let hit: StoredDevice | undefined;
    for (const d of devices) if (timingSafeEqualStr(d.tokenHash, hash)) hit = d;
    return hit;
  };

  return {
    issue(name) {
      const t = now();
      const token = crypto.randomBytes(32).toString('hex');
      const device: StoredDevice = {
        id: crypto.randomBytes(6).toString('hex'), name: cleanName(name),
        createdAt: t, lastSeenAt: t, tokenHash: hashToken(token),
      };
      devices.push(device);
      persist();
      return { device: publicView(device), token };
    },

    match(token) {
      if (!token) return undefined;
      const device = find(token);
      if (!device) return undefined;
      device.lastSeenAt = now();
      if (device.lastSeenAt - (persistedSeen.get(device.id) ?? 0) >= DEVICE_SEEN_PERSIST_MS) persist();
      return publicView(device);
    },

    list() {
      return devices.map(publicView);
    },

    revoke(id) {
      const index = devices.findIndex((d) => d.id === id);
      if (index < 0) return false;
      devices.splice(index, 1);
      persistedSeen.delete(id);
      persist();
      return true;
    },
  };
}
