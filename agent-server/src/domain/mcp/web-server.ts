// input:  MCP SDK, UI-file registrar, and route-context file path
// output: Web-UI-specific MCP stdio service assembled from production registration
// pos:    standalone platform server loaded
//         ONLY for Web-UI-originated sessions (channel carries the `web:` prefix) — Claude via
//         mcp-config-web.json layering. Not loaded for Slack/Feishu/thread sessions.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerUiFileTools } from './tools/ui-file.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';

const log = createLogger('mcp-web');

// --- Config from env / CLI args ---

function getCliArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefixed = process.argv.find(a => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  return null;
}

const routeContextFile: string | null =
  getCliArg('--route-context-file') || process.env.CORTEX_ROUTE_CONTEXT_FILE || null;

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-web', version: CORTEX_VERSION });

registerUiFileTools(server, { routeContextFile });

// --- Start (called by barrel when run as standalone) ---

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  startServer().catch((e) => {
    log.error(e);
    process.exit(1);
  });
}
