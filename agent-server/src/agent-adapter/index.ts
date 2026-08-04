// input:  backend labels and restored PI transcript paths
// output: adapter lookup, PI path registration, public re-exports
// pos:    Unified entry point for the Agent adapter system
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { AgentAdapter, Backend } from './types.js';
import { ClaudeAdapter } from './claude/adapter.js';
import { PIAdapter } from './pi/adapter.js';
import { ensureAuthVisible } from './pi/agent-dir.js';
import { DEFAULT_SESSION_DIR, PI_AGENT_DIR } from './pi/defaults.js';
import { piProviderDiscovery } from './pi/discovery.js';

export * from './types.js';
export * from './capabilities.js';
export * from './normalize/event-types.js';
export * from './normalize/hooks.js';
export * from './normalize/tool-names.js';

// The daemon's PI collaborators are injected here rather than defaulted inside the adapter: the host
// PI home, its cached provider scan and its auth mirroring are exactly the ambient reaches design
// §13 A1/A6/A7 forbids a trial from touching, and this registry is the daemon-only owner of all three.
const PI_ADAPTER = new PIAdapter(undefined, DEFAULT_SESSION_DIR, piProviderDiscovery, {
  agentDir: PI_AGENT_DIR,
  prepareAgentDir: (agentDir) => ensureAuthVisible({ agentDir }),
});

const ADAPTERS: Record<Backend, AgentAdapter> = {
  claude: new ClaudeAdapter(),
  pi: PI_ADAPTER,
};

export function getAdapter(backend: Backend): AgentAdapter {
  const adapter = ADAPTERS[backend];
  if (!adapter) throw new Error(`Unknown backend: ${backend}`);
  return adapter;
}

export function registerPISessionPath(sessionId: string, sessionPath: string): void {
  PI_ADAPTER.registerSessionPath(sessionId, sessionPath);
}

export async function closeAllAdapters(): Promise<void> {
  for (const adapter of Object.values(ADAPTERS)) {
    for (const key of adapter.listSessions()) {
      try { await adapter.close(key); } catch { /* best-effort */ }
    }
  }
}
