// input:  portable MCP servers and runtime root
// output: private deterministic Claude MCP config
// pos:    Claude supplemental MCP config writer
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@core/log.js';
import { DATA_DIR } from '@core/paths.js';
import { ensurePrivateRuntimeDirectory } from '../mcp-private-dir.js';
import type { McpServerConfig } from '../types.js';

const log = createLogger('claude-mcp-config');
const REMOTE_PROXY_PATH = fileURLToPath(new URL('./remote-mcp-proxy.js', import.meta.url));

export interface ClaudeSupplementalMcpConfig {
  path: string;
  identity: string;
}

export interface ClaudeSupplementalMcpConfigOptions {
  runtimeDir?: string;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function orderedObject(entries: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries.sort(([a], [b]) => compareText(a, b)));
}

function stdioEntry(server: Extract<McpServerConfig, { type: 'stdio' }>): Record<string, unknown> {
  return {
    command: server.command,
    args: [...server.args],
    env: orderedObject(Object.entries(server.env)),
    cwd: server.cwd,
  };
}

function remoteEntry(server: Extract<McpServerConfig, { type: 'streamable-http' | 'sse' }>): Record<string, unknown> {
  return {
    type: server.type === 'streamable-http' ? 'http' : 'sse',
    url: server.url,
    headers: orderedObject(Object.entries(server.headers)),
  };
}

function claudeServerEntry(server: McpServerConfig): Record<string, unknown> {
  return server.type === 'stdio' ? stdioEntry(server) : remoteEntry(server);
}

export function claudeSupplementalMcpConfigJson(mcpServers: readonly McpServerConfig[]): string {
  const entries = mcpServers
    .map((server) => [server.name, claudeServerEntry(server)] as const)
    .sort(([a], [b]) => compareText(a, b));
  return `${JSON.stringify({ mcpServers: Object.fromEntries(entries) }, null, 2)}\n`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function ownerOnly(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function validatedText(filePath: string): string {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Claude supplemental MCP file is invalid: ${filePath}`);
  }
  if (!ownerOnly(stat.mode & 0o777)) {
    throw new Error(`Claude supplemental MCP file is not private: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function validateClaudeSupplementalMcpConfig(filePath: string, identity: string): void {
  if (path.basename(filePath) !== `${identity}.json`) {
    throw new Error(`Claude supplemental MCP file identity mismatch: ${filePath}`);
  }
  if (sha256(validatedText(filePath)) !== identity) {
    throw new Error(`Claude supplemental MCP file identity mismatch: ${filePath}`);
  }
}

function validateExistingFile(filePath: string, expected: string): void {
  if (validatedText(filePath) !== expected) {
    throw new Error(`Claude supplemental MCP file content mismatch: ${filePath}`);
  }
  validateClaudeSupplementalMcpConfig(filePath, sha256(expected));
}

function writePrivateAtomic(filePath: string, text: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function privateContentFile(directory: string, text: string, label: string): string {
  ensurePrivateRuntimeDirectory(directory, label);
  const filePath = path.join(directory, `${sha256(text)}.json`);
  if (fs.existsSync(filePath)) {
    validateExistingFile(filePath, text);
    return filePath;
  }
  try {
    writePrivateAtomic(filePath, text);
  } catch (error) {
    if (!fs.existsSync(filePath)) throw error;
    validateExistingFile(filePath, text);
  }
  return filePath;
}

function proxyServer(
  server: Extract<McpServerConfig, { type: 'streamable-http' | 'sse' }>,
  runtimeDir: string,
): McpServerConfig {
  const directory = path.join(runtimeDir, 'claude-mcp-proxies');
  const text = `${JSON.stringify({
    type: server.type, url: server.url,
    headers: orderedObject(Object.entries(server.headers)),
  })}\n`;
  const configPath = privateContentFile(directory, text, 'Claude remote MCP runtime');
  return {
    name: server.name, type: 'stdio', command: process.execPath,
    args: [REMOTE_PROXY_PATH, configPath], env: {}, cwd: directory,
  };
}

function runtimeServers(
  mcpServers: readonly McpServerConfig[],
  runtimeDir: string,
): McpServerConfig[] {
  return mcpServers.flatMap((server) => {
    if (server.type === 'stdio') return [server];
    try {
      return [proxyServer(server, runtimeDir)];
    } catch (error) {
      log.warn(`Skipping Claude remote MCP '${server.name}': ${(error as Error).message}`);
      return [];
    }
  });
}

export function writeClaudeSupplementalMcpConfig(
  mcpServers: readonly McpServerConfig[],
  options: ClaudeSupplementalMcpConfigOptions = {},
): ClaudeSupplementalMcpConfig {
  const runtimeDir = path.resolve(options.runtimeDir ?? path.join(DATA_DIR, 'data', 'plugin-runtime'));
  ensurePrivateRuntimeDirectory(runtimeDir, 'Claude MCP runtime');
  const text = claudeSupplementalMcpConfigJson(runtimeServers(mcpServers, runtimeDir));
  const identity = sha256(text);
  const directory = path.join(runtimeDir, 'claude-mcp');
  const filePath = privateContentFile(directory, text, 'Claude MCP runtime');
  return { path: filePath, identity };
}
