// input:  PiSessionRequest, provider quota callback
// output: Cortex's PI extensions as in-process factories for one session
// pos:    Assembles the extension set a PI session runs with
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { CodexQuotaReading } from '@domain/costs/codex-quota.js';
import type { PiSessionRequest } from './session-options.js';
import { installMcpBridge, createMcpBridgeDeps } from './mcp-bridge.js';
import { installHookBridge } from './hook-bridge.js';
import { installToolShims } from './tool-shims.js';
import { createQuotaProbe } from './quota-probe.js';
import type { ExtensionAPI as LocalExtensionAPI } from './pi-ext-types.js';

export interface CortexExtensionHooks {
  onProviderQuota?: (reading: CodexQuotaReading) => void;
}

/**
 * The same four extensions `pi --mode rpc` loaded from compiled files, now closed over the
 * session's request instead of reading `process.env`: the MCP bridge (Cortex bundles in-process,
 * plugin servers as before), the tool shims, the hook bridge unless the role disabled hooks, and
 * the quota probe for gateway-routed runs that have somewhere to report to.
 */
export function createCortexExtensions(
  request: PiSessionRequest,
  hooks: CortexExtensionHooks = {},
): InlineExtension[] {
  const extensions: InlineExtension[] = [
    {
      name: 'cortex-mcp-bridge',
      factory: (pi) => installMcpBridge(pi, createMcpBridgeDeps(request.env, request.pluginMcpServers)),
    },
    {
      name: 'cortex-tool-shims',
      // The shims still type against the local extension stub until the subagent moves in-process.
      factory: (pi: ExtensionAPI) => installToolShims(pi as unknown as LocalExtensionAPI, request.env),
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
