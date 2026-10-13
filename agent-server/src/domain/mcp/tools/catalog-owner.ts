import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mergeModelCatalogs, withoutModelCatalog } from '@core/agents/subagent/catalog.js';

/** Capture public registration handles after the allowlist gate, not SDK private state. */
export function registerWithModelCatalogOwner(server: McpServer, register: () => void): void {
  const original = server.tool;
  const delegation = new Map<string, RegisteredTool>();
  server.tool = ((...args: Parameters<McpServer['tool']>) => {
    const tool = original.apply(server, args);
    if (tool && (args[0] === 'agent' || args[0] === 'worker_spawn')) delegation.set(args[0], tool);
    return tool;
  }) as McpServer['tool'];
  try { register(); }
  finally { server.tool = original; }
  const worker = delegation.get('worker_spawn');
  const agent = delegation.get('agent');
  if (agent && worker) {
    agent.update({ description: mergeModelCatalogs(agent.description ?? '', worker.description ?? '') });
    worker.update({ description: withoutModelCatalog(worker.description ?? '') });
  }
}
