import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_FILE } from './paths.js';

export interface PendingUpgrade {
  from: string;
  to: string;
  method: 'auto' | 'prompt' | 'manual';
  startedAt: string;
}

/** Small cross-boot facts; survives a telemetry wipe (it holds nothing worth deleting). */
export interface TelemetryState {
  lastHeartbeatAt: string | null;
  /** The version the previous boot ran, to spot upgrades no installer announced. */
  lastVersion: string | null;
  funnelSent: string[];
  pendingUpgrade: PendingUpgrade | null;
}

const EMPTY: TelemetryState = {
  lastHeartbeatAt: null, lastVersion: null, funnelSent: [], pendingUpgrade: null,
};

export function readTelemetryState(file: string = STATE_FILE): TelemetryState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TelemetryState>;
    return {
      ...EMPTY,
      ...raw,
      funnelSent: Array.isArray(raw.funnelSent) ? raw.funnelSent.filter((s) => typeof s === 'string') : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Read-modify-write; never throws (an unwritable home just forgets). */
export function updateTelemetryState(
  change: (state: TelemetryState) => TelemetryState,
  file: string = STATE_FILE,
): TelemetryState {
  const next = change(readTelemetryState(file));
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch { /* best effort */ }
  return next;
}
