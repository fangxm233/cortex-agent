import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface AgentsMDEntry {
  path: string;
  content: string;
  mtimeMs: number;
  deviceId?: string;
}

const AGENTS_MD_NAMES = ['AGENTS.md', 'AGENTS.local.md'];
const DEVICE_ID = os.hostname();
const MAX_FILE_SIZE = 200 * 1024;
const MAX_DEPTH = 20;

function tryReadEntry(filePath: string): AgentsMDEntry | null {
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

export function scanAgentsMDChain(targetFilePath: string): AgentsMDEntry[] {
  const entries: AgentsMDEntry[] = [];
  const seen = new Set<string>();

  let dir: string;
  try {
    dir = path.dirname(path.resolve(targetFilePath));
  } catch {
    return entries;
  }

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    for (const name of AGENTS_MD_NAMES) {
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
    const homeAgents = path.join(cortexHome, 'AGENTS.md');
    if (!seen.has(homeAgents)) {
      seen.add(homeAgents);
      const entry = tryReadEntry(homeAgents);
      if (entry) entries.push(entry);
    }
  } catch {
    // homedir unavailable — skip
  }

  return entries;
}
