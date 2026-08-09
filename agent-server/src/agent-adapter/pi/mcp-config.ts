// input:  portable MCP servers and runtime root
// output: private deterministic PI MCP config and reload
// pos:    PI plugin MCP config writer and parser
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@core/paths.js';
import { ensurePrivateRuntimeDirectory } from '../mcp-private-dir.js';
import type { McpRemoteServerConfig, McpServerConfig, McpStdioServerConfig } from '../types.js';

export const PI_PLUGIN_MCP_CONFIG_ENV = 'CORTEX_PI_PLUGIN_MCP_CONFIG_PATH';

export interface PiPluginMcpConfig {
  path: string;
  identity: string;
}

export interface PiPluginMcpConfigOptions {
  runtimeDir?: string;
}

export interface PiPluginMcpConfigIssue {
  path: string;
  message: string;
}

export interface PiPluginMcpConfigLoadResult {
  servers: McpServerConfig[];
  issues: PiPluginMcpConfigIssue[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function orderedObject(entries: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries.sort(([a], [b]) => compareText(a, b)));
}

function serializeStdio(server: McpStdioServerConfig): McpStdioServerConfig {
  return {
    name: server.name,
    type: 'stdio',
    command: server.command,
    args: [...server.args],
    env: orderedObject(Object.entries(server.env)) as Record<string, string>,
    cwd: server.cwd,
  };
}

function serializeRemote(server: McpRemoteServerConfig): McpRemoteServerConfig {
  return {
    name: server.name,
    type: server.type,
    url: server.url,
    headers: orderedObject(Object.entries(server.headers)) as Record<string, string>,
  };
}

function serializeServer(server: McpServerConfig): McpServerConfig {
  return server.type === 'stdio' ? serializeStdio(server) : serializeRemote(server);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function ownerOnly(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function fileIdentity(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function exactEnvelope(value: unknown): value is { mcpServers: unknown[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && keys[0] === 'mcpServers' && Array.isArray((value as { mcpServers?: unknown }).mcpServers);
}

function validatedConfigText(filePath: string): string {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`PI plugin MCP file is invalid: ${filePath}`);
  if (!ownerOnly(stat.mode & 0o777)) throw new Error(`PI plugin MCP file is not private: ${filePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  if (sha256(text) !== fileIdentity(filePath)) throw new Error(`PI plugin MCP file identity mismatch: ${filePath}`);
  return text;
}

function validateExistingFile(filePath: string, expected: string): void {
  if (validatedConfigText(filePath) !== expected) {
    throw new Error(`PI plugin MCP file content mismatch: ${filePath}`);
  }
  fs.chmodSync(filePath, 0o600);
}

function writePrivateAtomic(filePath: string, text: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function parseStringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PI plugin MCP ${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`PI plugin MCP ${field}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}

function parseStdioServer(value: unknown): McpStdioServerConfig {
  const raw = value as Record<string, unknown>;
  if (typeof raw.command !== 'string') throw new Error('PI plugin MCP stdio command must be a string');
  if (!Array.isArray(raw.args) || raw.args.some(entry => typeof entry !== 'string')) {
    throw new Error('PI plugin MCP stdio args must be a string array');
  }
  if (typeof raw.cwd !== 'string') throw new Error('PI plugin MCP stdio cwd must be a string');
  return {
    name: requireName(raw.name),
    type: 'stdio',
    command: raw.command,
    args: [...raw.args as string[]],
    env: parseStringRecord(raw.env, 'env'),
    cwd: raw.cwd,
  };
}

function parseRemoteServer(value: unknown, type: 'streamable-http' | 'sse'): McpRemoteServerConfig {
  const raw = value as Record<string, unknown>;
  if (typeof raw.url !== 'string') throw new Error(`PI plugin MCP ${type} url must be a string`);
  return {
    name: requireName(raw.name),
    type,
    url: raw.url,
    headers: parseStringRecord(raw.headers, 'headers'),
  };
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('PI plugin MCP server name must be a non-empty string');
  return value;
}

function parseServer(value: unknown): McpServerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PI plugin MCP server entries must be objects');
  }
  const type = (value as Record<string, unknown>).type;
  if (type === 'stdio') return parseStdioServer(value);
  if (type === 'streamable-http' || type === 'sse') return parseRemoteServer(value, type);
  throw new Error('PI plugin MCP server type must be stdio, streamable-http, or sse');
}

function sortedServers(servers: McpServerConfig[]): McpServerConfig[] {
  return servers.sort((left, right) => compareText(left.name, right.name));
}

function parseEnvelope(text: string, filePath: string): unknown[] {
  const raw = JSON.parse(text) as unknown;
  if (!exactEnvelope(raw)) throw new Error(`PI plugin MCP config is invalid: ${filePath}`);
  return raw.mcpServers;
}

type ParsedEntry = { server: McpServerConfig } | { issue: PiPluginMcpConfigIssue };

function recoverEntryIssue(error: unknown, pathValue: string, strict: boolean): ParsedEntry {
  const message = error instanceof Error ? error.message : String(error);
  if (strict) throw new Error(message);
  return { issue: { path: pathValue, message } };
}

function parseEntry(value: unknown, pathValue: string, strict: boolean): ParsedEntry {
  try {
    return { server: parseServer(value) };
  } catch (error) {
    return recoverEntryIssue(error, pathValue, strict);
  }
}

function duplicateIssue(name: string, pathValue: string, strict: boolean): PiPluginMcpConfigIssue {
  const message = `Duplicate PI plugin MCP server name: ${name}`;
  if (strict) throw new Error(message);
  return { path: `${pathValue}.name`, message };
}

function acceptParsedEntry(
  parsed: ParsedEntry,
  pathValue: string,
  strict: boolean,
  seenNames: Set<string>,
  result: PiPluginMcpConfigLoadResult,
): void {
  if ('issue' in parsed) return void result.issues.push(parsed.issue);
  if (seenNames.has(parsed.server.name)) {
    result.issues.push(duplicateIssue(parsed.server.name, pathValue, strict));
    return;
  }
  seenNames.add(parsed.server.name);
  result.servers.push(parsed.server);
}

function parseEntries(entries: unknown[], filePath: string, strict: boolean): PiPluginMcpConfigLoadResult {
  const result: PiPluginMcpConfigLoadResult = { servers: [], issues: [] };
  const seenNames = new Set<string>();
  for (const [index, value] of entries.entries()) {
    const pathValue = `${filePath}#mcpServers[${index}]`;
    const parsed = parseEntry(value, pathValue, strict);
    acceptParsedEntry(parsed, pathValue, strict, seenNames, result);
  }
  return { servers: sortedServers(result.servers), issues: result.issues };
}

export function piPluginMcpConfigJson(mcpServers: readonly McpServerConfig[]): string {
  const servers = mcpServers
    .map(serializeServer)
    .sort((left, right) => compareText(left.name, right.name));
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

export function loadPiPluginMcpConfig(filePath: string): PiPluginMcpConfigLoadResult {
  try {
    const entries = parseEnvelope(validatedConfigText(filePath), filePath);
    return parseEntries(entries, filePath, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { servers: [], issues: [{ path: filePath, message }] };
  }
}

export function readPiPluginMcpConfig(filePath: string): McpServerConfig[] {
  const entries = parseEnvelope(validatedConfigText(filePath), filePath);
  return parseEntries(entries, filePath, true).servers;
}

export function writePiPluginMcpConfig(
  mcpServers: readonly McpServerConfig[],
  options: PiPluginMcpConfigOptions = {},
): PiPluginMcpConfig {
  const text = piPluginMcpConfigJson(mcpServers);
  const identity = sha256(text);
  const runtimeDir = path.resolve(options.runtimeDir ?? path.join(DATA_DIR, 'data', 'plugin-runtime'));
  const directory = path.join(runtimeDir, 'pi-mcp');
  const filePath = path.join(directory, `${identity}.json`);
  ensurePrivateRuntimeDirectory(runtimeDir, 'PI MCP runtime');
  ensurePrivateRuntimeDirectory(directory, 'PI MCP runtime');
  if (fs.existsSync(filePath)) {
    validateExistingFile(filePath, text);
    return { path: filePath, identity };
  }
  try {
    writePrivateAtomic(filePath, text);
  } catch (error) {
    if (!fs.existsSync(filePath)) throw error;
    validateExistingFile(filePath, text);
  }
  return { path: filePath, identity };
}
