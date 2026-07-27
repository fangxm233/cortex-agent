// input:  install root and PI private session directory
// output: PI adapter session and compiled-extension paths
// pos:    Static path defaults for PI process spawning
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import { INSTALL_ROOT } from '@core/utils.js';
import { PI_SESSIONS_DIR } from './agent-dir.js';

export const DEFAULT_SESSION_DIR = PI_SESSIONS_DIR;
export const MCP_BRIDGE_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/mcp-bridge.js');
export const TOOL_SHIMS_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/tool-shims.js');
export const HOOK_BRIDGE_PATH = path.join(INSTALL_ROOT, 'dist/agent-adapter/pi/hook-bridge.js');
