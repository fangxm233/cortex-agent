// input:  MCP SDK, immutable benchmark policy, blocking thread registrar
// output: cortex-benchmark-thread MCP stdio service
// pos:    Benchmark-only dynamic thread MCP server
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from '@core/log.js';
import { isMainModule } from '@core/utils.js';
import { CORTEX_VERSION } from '@core/version.js';
import {
  loadBenchmarkThreadPolicy, registerBenchmarkThreadRunTool,
} from './tools/benchmark-thread-run.js';

const log = createLogger('mcp-benchmark-thread');

export async function startServer(): Promise<void> {
  const shutdown = new AbortController();
  const server = new McpServer({ name: 'cortex-benchmark-thread', version: CORTEX_VERSION });
  registerBenchmarkThreadRunTool(server, loadBenchmarkThreadPolicy(), shutdown.signal);
  const closeInput = () => shutdown.abort(new Error('benchmark MCP stdin closed'));
  process.stdin.once('end', closeInput);
  process.stdin.once('close', closeInput);
  await server.connect(new StdioServerTransport());
}

if (isMainModule(import.meta.url)) {
  startServer().catch((error) => {
    log.error(error);
    process.exit(1);
  });
}
