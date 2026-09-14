import { ClaudeAdapter } from '../../agent-adapter/claude/adapter.js';
import { PIAdapter } from '../../agent-adapter/pi/adapter.js';
import { ensureAuthVisible, USER_PI_MODELS_PATH } from '../../agent-adapter/pi/agent-dir.js';
import { DEFAULT_SESSION_DIR, PI_AGENT_DIR } from '../../agent-adapter/pi/defaults.js';
import { piProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import { handleRateLimitEvent } from '../costs/rate-limit-throttle.js';
import { usageStore } from '../costs/usage-store.js';
import { openBundledMcpServer } from '../mcp/bundled-server.js';
import { runForeignSubagent } from '../agents/subagent/foreign.js';
import type {
  StartBackgroundSubagent, StopBackgroundSubagent,
} from '../../agent-adapter/pi/background-subagent.js';

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
  openBundledMcpServer,
  subagent: {
    runForeignSubagent,
    // Late-bound on purpose: registering a background run reaches the delivery route in
    // `orchestration/`, which domain may not import. The composition root registers the real
    // implementation at boot (see `setPiBackgroundSubagentBridge`), the same way
    // `setSubagentTurnSender` and `registerTaskTreeSubscribers` are bound.
    startBackgroundSubagent: (request) => (piBackground.start
      ? piBackground.start(request)
      : Promise.reject(new Error('run_in_background is unavailable in this session.'))),
    // An unregistered bridge has no run table, so no id it was given can exist — which is exactly
    // what "null" means to `agent_stop`. The tool stays registered either way.
    stopBackgroundSubagent: (id) => (piBackground.stop ? piBackground.stop(id) : Promise.resolve(null)),
  },
});

const piBackground: {
  start?: StartBackgroundSubagent;
  stop?: StopBackgroundSubagent;
} = {};

/** Register orchestration's half of PI's `agent` tool. Called once from `entry/app.ts`; passing
 *  null unregisters it, which is what a test that wants a domain-only daemon does. */
export function setPiBackgroundSubagentBridge(bridge: {
  startBackgroundSubagent: StartBackgroundSubagent;
  stopBackgroundSubagent: StopBackgroundSubagent;
} | null): void {
  piBackground.start = bridge?.startBackgroundSubagent;
  piBackground.stop = bridge?.stopBackgroundSubagent;
}

const CLAUDE_ADAPTER = new ClaudeAdapter({ onRateLimit: handleRateLimitEvent });

/** The daemon's Claude engine adapter. Stateless: `SessionEngines` owns the sessions it opens,
 *  and this is the one place the daemon wires the adapter to domain state (D10). */
export function getClaudeEngineAdapter(): ClaudeAdapter {
  return CLAUDE_ADAPTER;
}

/** The daemon's PI engine adapter — the same object `setPiBackgroundSubagentBridge` arms, and the
 *  one `SessionEngines.registerSessionPath` writes through. */
export function getPiEngineAdapter(): PIAdapter {
  return PI_ADAPTER;
}
