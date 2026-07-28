// input:  fs/path/os, target file path
// output: CortexMDEntry[] with host identity and ancestor rules
// pos:    Scans local CORTEX.md ancestor chains for tool injection
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CortexMDEntry {
  path: string;       // absolute path on this device
  content: string;    // file contents (utf8)
  mtimeMs: number;    // mtime in ms epoch, for downstream cache invalidation
  deviceId?: string;  // physical hostname, optional for old-client compatibility
}

const CORTEX_MD_NAMES = ['CORTEX.md', 'CORTEX.local.md'];
const DEVICE_ID = os.hostname();
const MAX_FILE_SIZE = 200 * 1024;
const MAX_DEPTH = 20;

function tryReadEntry(filePath: string): CortexMDEntry | null {
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return null;
    if (stat.size > MAX_FILE_SIZE) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return { path: filePath, content, mtimeMs: stat.mtimeMs, deviceId: DEVICE_ID };
  } catch {
    return null;
  }
}

/** Walk from the directory containing `targetFilePath` up to the filesystem root,
 *  collecting CORTEX.md and CORTEX.local.md at each level. Also appends the
 *  remote user's ~/.cortex/CORTEX.md if present. Returns leaf→root order. */
export function scanCortexMDChain(targetFilePath: string): CortexMDEntry[] {
  const entries: CortexMDEntry[] = [];
  const seen = new Set<string>();

  let dir: string;
  try {
    dir = path.dirname(path.resolve(targetFilePath));
  } catch {
    return entries;
  }

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    for (const name of CORTEX_MD_NAMES) {
      const p = path.join(dir, name);
      if (seen.has(p)) continue;
      seen.add(p);
      const entry = tryReadEntry(p);
      if (entry) entries.push(entry);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  try {
    const cortexHome = process.env.CORTEX_HOME
      ? path.resolve(process.env.CORTEX_HOME)
      : path.join(os.homedir(), '.cortex');
    const homeCortex = path.join(cortexHome, 'CORTEX.md');
    if (!seen.has(homeCortex)) {
      seen.add(homeCortex);
      const entry = tryReadEntry(homeCortex);
      if (entry) entries.push(entry);
    }
  } catch {
    // homedir unavailable — skip
  }

  return entries;
}
