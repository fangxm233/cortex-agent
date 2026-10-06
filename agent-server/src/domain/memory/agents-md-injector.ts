import { DATA_DIR } from '@core/paths.js';
// Shared with the agents-md-injector hook: one cache format, one key, one inline budget.
import {
  agentsMdCacheDir, agentsMdCacheKey, overflowNotice, pruneCacheDir, selectWithinBudget, withAgentsMdCache,
} from '../../../defaults/hooks/cortex-context-lib.mjs';

export interface AgentsMDEntry {
  path: string;
  content: string;
  mtimeMs: number;
  deviceId?: string;
}

export interface AgentsMDBlock {
  type: 'text';
  text: string;
}

export interface AgentsMDInjectorOptions {
  sessionId?: string;
  cacheDir?: string;
}

/** Injects the AGENTS.md chain that cortex-client returns for a remote path, at most once per
 *  (physical device, path, mtime) per session — the same dedup cache the local hook uses. */
export class AgentsMDInjector {
  private readonly memoryCache = new Map<string, number>();
  private readonly cacheDir: string;
  private readonly sessionId: string | undefined;

  constructor(options: AgentsMDInjectorOptions = {}) {
    this.cacheDir = options.cacheDir ?? agentsMdCacheDir(DATA_DIR);
    this.sessionId = options.sessionId ?? process.env.CORTEX_SESSION_ID;
    pruneCacheDir(this.cacheDir);
  }

  buildBlocks(device: string, entries: AgentsMDEntry[], markOnlyPaths?: Set<string>): AgentsMDBlock[] {
    if (!entries || entries.length === 0) return [];
    const keyOf = (entry: AgentsMDEntry) => agentsMdCacheKey(entry.deviceId?.trim() || device, entry.path);
    return withAgentsMdCache(this.cacheDir, this.sessionId, (cache) => {
      let changed = false;
      const fresh: AgentsMDEntry[] = [];
      for (const entry of entries) {
        if (cache.get(keyOf(entry)) === entry.mtimeMs) continue;
        if (markOnlyPaths?.has(entry.path)) {
          cache.set(keyOf(entry), entry.mtimeMs);
          changed = true;
        } else {
          fresh.push(entry);
        }
      }
      const { included, blocks, truncated } = selectWithinBudget(fresh, (entry) => this.formatBlock(device, entry));
      for (const entry of included) {
        cache.set(keyOf(entry), entry.mtimeMs);
        changed = true;
      }
      const texts = truncated.length > 0
        ? [...blocks, overflowNotice(truncated.map((entry) => `${device}:${entry.path}`))]
        : blocks;
      return { value: texts.map((text): AgentsMDBlock => ({ type: 'text', text })), changed };
    }, this.memoryCache);
  }

  private formatBlock(device: string, entry: AgentsMDEntry): string {
    return `<system-reminder>\n` +
      `Auto-loaded AGENTS.md from ${device}:${entry.path} ` +
      `(ancestor of accessed path on remote device). ` +
      `These instructions apply to files under this directory on that device.\n\n` +
      entry.content +
      `\n</system-reminder>`;
  }
}

let defaultAgentsInjector: AgentsMDInjector | null = null;

export function getDefaultAgentsInjector(): AgentsMDInjector {
  if (!defaultAgentsInjector) defaultAgentsInjector = new AgentsMDInjector();
  return defaultAgentsInjector;
}
