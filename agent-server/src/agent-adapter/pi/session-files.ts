import { readdirSync } from 'fs';
import * as path from 'path';

import { selectPISessionFilename } from '@core/pi-session-filename.js';

/** Resolve PI's exact id-bearing filename without opening transcript bodies. */
export function findPISessionFilePath(sessionDir: string, sessionId: string): string | null {
  if (!sessionId) return null;
  try {
    const filename = selectPISessionFilename(readdirSync(sessionDir), sessionId);
    return filename ? path.join(sessionDir, filename) : null;
  } catch {
    return null;
  }
}
