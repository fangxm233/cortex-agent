import path from 'node:path';
import { STORE_DIR } from '@core/paths.js';

/** Everything telemetry keeps on disk lives here; nothing outside it is written. */
export const TELEMETRY_DIR = path.join(STORE_DIR, 'telemetry');
export const INSTALL_ID_FILE = path.join(TELEMETRY_DIR, 'install-id');
export const OUTBOX_FILE = path.join(TELEMETRY_DIR, 'outbox.jsonl');
export const STATE_FILE = path.join(TELEMETRY_DIR, 'state.json');
export const ROLLUP_PREFIX = 'rollup-';

export function rollupFile(day: string, dir: string = TELEMETRY_DIR): string {
  return path.join(dir, `${ROLLUP_PREFIX}${day}.json`);
}
