// input:  install root and the Cortex data directory
// output: PI adapter path defaults and compiled-extension paths
// pos:    Static path defaults for PI process spawning
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { DATA_DIR, INSTALL_ROOT } from '@core/utils.js';

/** PI_CODING_AGENT_DIR: PI reads models.json and auth.json from this dir. Daemon default only —
 *  a trial derives its own agent dir from the trial root (design §13 A1). */
export const PI_AGENT_DIR = path.join(DATA_DIR, 'data', 'pi');
export const PI_SESSIONS_DIR = path.join(DATA_DIR, 'logs', 'sessions-pi');
export const PI_MODELS_PATH = path.join(PI_AGENT_DIR, 'models.json');

export const DEFAULT_SESSION_DIR = PI_SESSIONS_DIR;
export const MCP_BRIDGE_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/mcp-bridge.js');
export const TOOL_SHIMS_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/tool-shims.js');
export const HOOK_BRIDGE_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/hook-bridge.js');
export const QUOTA_PROBE_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/quota-probe.js');

/** PI's models.json always lives beside auth.json inside the agent dir, so one parameter fixes
 *  both (design §13 P7 / A3): a trial agent dir implies a trial provider catalog. */
export function piModelsPath(agentDir: string): string {
  return path.join(agentDir, 'models.json');
}
