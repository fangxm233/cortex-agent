// input:  the two engine adapter classes plus the daemon-owned collaborators they must not reach
// output: getAdapter / getEngineAdapter — the daemon's two assembled engine adapters
// pos:    domain/runs — the one assembly point where an adapter is wired to domain state (D10)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { ClaudeAdapter } from '../../agent-adapter/claude/adapter.js';
import { PIAdapter } from '../../agent-adapter/pi/adapter.js';
import { ensureAuthVisible, USER_PI_MODELS_PATH } from '../../agent-adapter/pi/agent-dir.js';
import { DEFAULT_SESSION_DIR, PI_AGENT_DIR } from '../../agent-adapter/pi/defaults.js';
import { piProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import type { Backend } from '../../agent-adapter/types.js';
import { handleRateLimitEvent } from '../costs/rate-limit-throttle.js';
import { usageStore } from '../costs/usage-store.js';

// `agent-adapter` is a driver: it knows how to talk to a CLI and nothing about what a throttle or
// a usage row means (D10). Every collaborator that carries daemon state is therefore injected from
// here rather than defaulted inside the adapter — the host PI home, its cached provider scan, its
// auth mirroring, the push usage cache, and the rate-limit throttle. A trial builds its own
// adapters with its own (or no) collaborators, and reaches none of these.
//
// Unset hooks are not silent no-ops by accident: PIAdapter reports no quota at all without both a
// store and a throttle, and ClaudeAdapter drops the CLI's rate-limit lines. That is the intended
// behaviour off the daemon path, and this file is the only place the daemon path is assembled.

const PI_ADAPTER = new PIAdapter(undefined, DEFAULT_SESSION_DIR, piProviderDiscovery, {
  agentDir: PI_AGENT_DIR,
  prepareAgentDir: (agentDir) => ensureAuthVisible({ agentDir }),
  userModelsPath: USER_PI_MODELS_PATH,
  usageStore,
  submitRateLimit: handleRateLimitEvent,
});

const CLAUDE_ADAPTER = new ClaudeAdapter({ onRateLimit: handleRateLimitEvent });

/** The Claude engine adapter. Stateless since P2.3c: `SessionEngines` owns the sessions it opens. */
export function getAdapter(backend: Backend): ClaudeAdapter {
  if (backend === 'claude') return CLAUDE_ADAPTER;
  throw new Error(`Unknown backend: ${backend}`);
}

/** The stateless PI engine factory. `SessionEngines` owns the sessions it opens. */
export function getEngineAdapter(backend: 'pi'): PIAdapter {
  if (backend !== 'pi') throw new Error(`Unknown engine backend: ${backend}`);
  return PI_ADAPTER;
}
