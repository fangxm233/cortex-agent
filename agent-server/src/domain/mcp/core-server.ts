// input:  MCP SDK plus remote, time, thread-control, task-monitor, and manager-Q&A registrars
// output: core MCP stdio service assembled directly from production tool registrations
// pos:    thread-agent MCP server; no duplicate exported tool-name inventory
//         Delegation is via the task system (cortex-task CLI); thread control tools (abort/split/wait)
//         let an agent steer its own thread; task_* tools monitor tasks. The agent-facing thread
//         spawn/monitor tools (thread_start + status/result/list/list_templates/cancel) were removed.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTaskOpsTools } from './tools/task-ops.js';
import { registerTimeTools } from './tools/time.js';
import { registerThreadTools } from './tools/thread-ops.js';
import { registerTaskMonitorTools } from './tools/task-monitor.js';
import { registerManagerQaTools } from './tools/manager-qa.js';
import { isMainModule } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { CORTEX_VERSION } from '@core/version.js';

const log = createLogger('mcp-core');

// --- McpServer + tool registration ---

const server = new McpServer({ name: 'cortex-core', version: CORTEX_VERSION });

registerTaskOpsTools(server);
registerTimeTools(server);
registerThreadTools(server);
registerTaskMonitorTools(server);
registerManagerQaTools(server);

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
