// input:  PiSessionRequest, provider quota callback
// output: Cortex's PI extensions as in-process factories for one session
// pos:    Assembles the extension set a PI session runs with
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { CodexQuotaReading } from '@domain/costs/codex-quota.js';
import type { PiSessionRequest } from './session-options.js';
import type { SubagentNotice } from './event-parser.js';
import type { SubagentUsageReport } from './subagent.js';
import { installMcpBridge, createMcpBridgeDeps } from './mcp-bridge.js';
import { installHookBridge } from './hook-bridge.js';
import { installToolShims } from './tool-shims.js';
import { createQuotaProbe } from './quota-probe.js';

export interface CortexExtensionHooks {
  /** Receives every provider quota reading, from this session and from its subagents alike. */
  onProviderQuota?: (reading: CodexQuotaReading) => void;
  /** Receives each event a subagent forwards for the parent's transcript. */
  onSubagentEvent?: (notice: SubagentNotice) => void;
  /** Receives each finished subagent's spend, so a child's tokens reach the cost ledger. */
  onSubagentUsage?: (report: SubagentUsageReport) => void;
}

/**
 * The four Cortex extensions a session runs with, each closed over the session's request rather
 * than `process.env`: the MCP bridge (Cortex bundles in-process, plugin servers as independent
 * connections), the tool shims, the hook bridge unless the role disabled hooks, and the quota
 * probe for gateway-routed runs that have somewhere to report to. The same quota reporter reaches
 * subagent sessions through the shims: a child's provider calls are the parent's spend, and codex
 * publishes quota only on real responses, so dropping the child's would starve the reading.
 */
export function createCortexExtensions(
  request: PiSessionRequest,
  hooks: CortexExtensionHooks = {},
): InlineExtension[] {
  // Resolved once and handed to both probes: the session's own and the one the tool shims install
  // on each subagent session. A run that does not report quota passes undefined to both, so
  // "does this run report quota" is decided here rather than in two places that could drift.
  const reportQuota = request.reportsProviderQuota ? hooks.onProviderQuota : undefined;
  const extensions: InlineExtension[] = [
    {
      name: 'cortex-mcp-bridge',
      factory: (pi) => installMcpBridge(pi, createMcpBridgeDeps(request.env, request.pluginMcpServers)),
    },
    {
      name: 'cortex-tool-shims',
      factory: (pi) => installToolShims(pi, request.env, {
        onSubagentEvent: hooks.onSubagentEvent,
        onSubagentUsage: hooks.onSubagentUsage,
        onProviderQuota: reportQuota,
      }),
    },
  ];
  if (!request.disableHooks) {
    extensions.push({ name: 'cortex-hook-bridge', factory: (pi) => installHookBridge(pi, request.env) });
  }
  if (reportQuota) {
    extensions.push({ name: 'cortex-quota-probe', factory: createQuotaProbe(reportQuota) });
  }
  return extensions;
}
