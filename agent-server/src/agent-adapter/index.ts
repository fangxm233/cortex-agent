// input:  backend labels, PI transcript paths, usage store
// output: daemon adapter lookup, PI path registration, pooled-session control, exports
// pos:    Unified entry point for the Agent adapter system
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { AgentAdapter, Backend } from './types.js';
import { ClaudeAdapter } from './claude/adapter.js';
import { PIAdapter } from './pi/adapter.js';
import { ensureAuthVisible, USER_PI_MODELS_PATH } from './pi/agent-dir.js';
import { DEFAULT_SESSION_DIR, PI_AGENT_DIR } from './pi/defaults.js';
import { piProviderDiscovery } from './pi/discovery.js';
import { usageStore } from '@domain/costs/usage-store.js';
import { createLogger } from '@core/log.js';

const log = createLogger('agent-adapter');

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
  userModelsPath: USER_PI_MODELS_PATH,
  usageStore,
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

// --- Pooled-session control, backend-neutral ---
//
// Every backend that pools a subprocess per sessionKey must be reachable from the same control
// points: `!new`, Stop, thread cleanup, session rewind and shutdown. Routing these through the
// AgentAdapter contract instead of one backend's module-level pool is what keeps a pooled process
// from surviving the conversation it belonged to.

function eachAdapter(): AgentAdapter[] {
  return Object.values(ADAPTERS);
}

function closeAdapterKey(adapter: AgentAdapter, key: string): void {
  adapter.close(key).catch((error: unknown) => {
    log.warn(`close ${adapter.backend} session ${key} failed: ${(error as Error)?.message ?? error}`);
  });
}

/** Graceful close of the pooled session for a key on every backend holding one. Fire-and-forget:
 *  callers are command handlers that must not block on a subprocess exit grace period. */
export function closeSession(channel: string, sessionKey?: string): void {
  const key = sessionKey || channel;
  for (const adapter of eachAdapter()) {
    if (adapter.listSessions().includes(key)) closeAdapterKey(adapter, key);
  }
}

/** Hard-stop the pooled session for a key. Returns true when at least one backend killed one. */
export function killSession(channel: string, sessionKey?: string): boolean {
  const key = sessionKey || channel;
  let killed = false;
  for (const adapter of eachAdapter()) {
    if (adapter.kill(key)) killed = true;
  }
  return killed;
}

/** Close every pooled session whose key starts with the prefix (thread cleanup). */
export function closeSessionsByPrefix(prefix: string): void {
  for (const adapter of eachAdapter()) {
    for (const key of adapter.listSessions()) {
      if (key.startsWith(prefix)) closeAdapterKey(adapter, key);
    }
  }
}

/** Close every pooled session on every backend (shutdown). */
export function closeAllSessions(): void {
  for (const adapter of eachAdapter()) {
    for (const key of adapter.listSessions()) closeAdapterKey(adapter, key);
  }
}
