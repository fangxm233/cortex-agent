// input:  PiSessionRequest, provider quota callback
// output: Cortex's PI extensions as in-process factories for one session
// pos:    Assembles the extension set a PI session runs with
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { CodexQuotaReading } from '@core/codex-quota.js';
import type { PiSessionRequest } from './session-options.js';
import type { SubagentNotice } from './event-parser.js';
import type { PiSubagentBridge } from './subagent-bridge.js';
import {
  installMcpBridge, createMcpBridgeDeps, type OpenBundledMcpServer,
} from './mcp-bridge.js';
import { installHookBridge } from './hook-bridge.js';
import { installToolShims } from './tool-shims.js';
import { createQuotaProbe } from './quota-probe.js';

export interface CortexExtensionHooks {
  onProviderQuota?: (reading: CodexQuotaReading) => void;
  /** Receives each event a subagent forwards for the parent's transcript. */
  onSubagentEvent?: (notice: SubagentNotice) => void;
  /** The daemon's subagent machinery — cross-backend children and background runs. Injected
   *  because it reaches the run registry and the delivery route (D10); left unset, the `agent`
   *  tool still delegates to nested PI children and refuses everything else. */
  subagent?: PiSubagentBridge;
  /** Builds the in-process Cortex bundle server. Injected because assembling one reaches the
   *  session registry and the subagent catalog (D10); unset ⇒ the session has no Cortex tools. */
  openBundledMcpServer?: OpenBundledMcpServer;
}

/**
 * The four Cortex extensions a session runs with, each closed over the session's request rather
 * than `process.env`: the MCP bridge (Cortex bundles in-process, plugin servers as independent
 * connections), the tool shims, the hook bridge unless the role disabled hooks, and the quota
 * probe for gateway-routed runs that have somewhere to report to.
 */
export function createCortexExtensions(
  request: PiSessionRequest,
  hooks: CortexExtensionHooks = {},
): InlineExtension[] {
  const extensions: InlineExtension[] = [
    {
      name: 'cortex-mcp-bridge',
      factory: (pi) => installMcpBridge(
        pi, createMcpBridgeDeps(request.env, request.pluginMcpServers, hooks.openBundledMcpServer),
      ),
    },
    {
      name: 'cortex-tool-shims',
      factory: (pi) => installToolShims(pi, request.env, {
        onSubagentEvent: hooks.onSubagentEvent,
        runForeignSubagent: hooks.subagent?.runForeignSubagent,
        startBackgroundSubagent: hooks.subagent?.startBackgroundSubagent,
        stopBackgroundSubagent: hooks.subagent?.stopBackgroundSubagent,
        openBundledMcpServer: hooks.openBundledMcpServer,
      }),
    },
  ];
  if (!request.disableHooks) {
    extensions.push({ name: 'cortex-hook-bridge', factory: (pi) => installHookBridge(pi, request.env) });
  }
  if (request.reportsProviderQuota && hooks.onProviderQuota) {
    extensions.push({ name: 'cortex-quota-probe', factory: createQuotaProbe(hooks.onProviderQuota) });
  }
  return extensions;
}
