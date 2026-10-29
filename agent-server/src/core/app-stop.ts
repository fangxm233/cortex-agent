import * as fs from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from './paths.js';

/**
 * app.js exit code for "the main port cannot be bound" (sysexits EX_CONFIG). Restarting cannot fix
 * it, so the daemon stops restarting on this code until the configuration changes.
 */
export const EXIT_PORT_UNAVAILABLE = 78;

/** Why app.js last stopped on its own, for `cortex daemon status` and the desktop app. */
export interface AppStopRecord {
  code: number;
  reason: 'port-in-use' | 'port-unavailable';
  port: number;
  host: string;
  message: string;
  at: string;
}

export const APP_STOP_FILE = path.join(STORE_DIR, 'app-stopped.json');

/** The operator-facing explanation of a failed main-port bind. */
export function portUnavailableMessage(port: number, host: string, code: string | undefined, envFile: string): string {
  if (code === 'EADDRINUSE') {
    return `Port ${port} is already in use by another process. `
      + `Set CORTEX_UI_PORT in ${envFile} to a free port, then run \`cortex daemon restart\`.`;
  }
  return `Cannot listen on ${host}:${port} (${code ?? 'unknown error'}). `
    + `Check CORTEX_UI_PORT and CORTEX_UI_HOST in ${envFile}.`;
}

export function writeAppStop(record: AppStopRecord, file = APP_STOP_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  } catch { /* the exit code still tells the daemon */ }
}

export function readAppStop(file = APP_STOP_FILE): AppStopRecord | null {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record && typeof record.message === 'string' ? record as AppStopRecord : null;
  } catch {
    return null;
  }
}

export function clearAppStop(file = APP_STOP_FILE): void {
  try { fs.unlinkSync(file); } catch { /* absent */ }
}
