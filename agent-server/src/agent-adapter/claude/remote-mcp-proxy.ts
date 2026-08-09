// input:  private remote MCP config and stdio client
// output: redirect-rejecting MCP tools proxy
// pos:    Claude remote MCP transport isolation shim
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { createLogger } from '@core/log.js';
import { isMainModule } from '@core/utils.js';
import { createRedirectRejectingFetch } from '../mcp-remote-fetch.js';

const log = createLogger('claude-remote-mcp-proxy');
const remoteConfigSchema = z.object({
  type: z.enum(['streamable-http', 'sse']),
  url: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  headers: z.record(z.string(), z.string()),
}).strict();

type RemoteConfig = z.infer<typeof remoteConfigSchema>;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function loadRemoteConfig(filePath: string): RemoteConfig {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Claude remote MCP proxy config is not private: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  if (path.basename(filePath) !== `${sha256(text)}.json`) {
    throw new Error(`Claude remote MCP proxy config identity mismatch: ${filePath}`);
  }
  return remoteConfigSchema.parse(JSON.parse(text));
}

function remoteTransport(config: RemoteConfig): Transport {
  const headers = { ...config.headers };
  const safeFetch = createRedirectRejectingFetch(headers);
  if (config.type === 'streamable-http') {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers }, fetch: safeFetch,
    });
  }
  return new SSEClientTransport(new URL(config.url), {
    fetch: safeFetch,
    eventSourceInit: { fetch: safeFetch },
    requestInit: { headers },
  });
}

function registerToolProxy(server: Server, upstream: Client): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) => upstream.callTool(request.params));
}

export async function startClaudeRemoteMcpProxy(filePath: string): Promise<void> {
  const config = loadRemoteConfig(filePath);
  const upstream = new Client({ name: 'cortex-claude-remote-proxy', version: '1.0.0' });
  await upstream.connect(remoteTransport(config));
  const server = new Server(
    { name: 'cortex-claude-remote-proxy', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  registerToolProxy(server, upstream);
  server.onclose = () => { void upstream.close().catch((error) => log.warn(error)); };
  await server.connect(new StdioServerTransport());
}

if (isMainModule(import.meta.url)) {
  startClaudeRemoteMcpProxy(process.argv[2] ?? '').catch((error) => {
    log.error(error);
    process.exit(1);
  });
}
