// input:  MCP SDK and the Web UI file registrar
// output: Web-specific MCP stdio service
// pos:    Serves file delivery tools to Web-originated sessions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerUiFileTools } from './tools/ui-file.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';

const log = createLogger('mcp-web');

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-web', version: CORTEX_VERSION });

registerUiFileTools(server);

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
