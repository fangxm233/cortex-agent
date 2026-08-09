// input:  plugin mcp.json files, schemas, path guards
// output: sanitized origin-only MCP views and private runtimes
// pos:    Portable MCP loader for plugin inventory
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import {
  portableMcpEnvelopeSchema,
  portableMcpServerSchema,
  type PortableMcpServer,
} from './agent-plugins-v1.js';
import {
  isRegularFile,
  lstatExists,
  resolveContainedAbsolutePath,
  resolveContainedRelativePath,
} from './fs-helpers.js';
import {
  attachPluginMcpRuntime,
  type PluginCatalogIssue,
  type PluginCatalogMcp,
  type PluginMcpServer,
} from './catalog-types.js';

interface PluginMcpLoadResult extends PluginCatalogMcp {
  issues: PluginCatalogIssue[];
}

function makeIssue(
  code: PluginCatalogIssue['code'],
  scope: PluginCatalogIssue['scope'],
  filePath: string | null,
  message: string,
): PluginCatalogIssue {
  return { code, scope, path: filePath, message };
}

function formatPath(parts: ReadonlyArray<PropertyKey>): string {
  return parts.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    return text ? `${text}.${String(part)}` : String(part);
  }, '');
}

function zodIssueText(
  error: { issues: Array<{ path: Array<PropertyKey>; message: string }> },
): string {
  return error.issues
    .map((issue) => `${formatPath(issue.path) || '(root)'}: ${issue.message}`)
    .join('; ');
}

function pluginDataDir(dataDir: string, pluginId: string): string {
  return path.join(dataDir, 'data', 'plugin-data', pluginId);
}

function expandPluginVars(
  value: string,
  pluginRoot: string,
  dataRoot: string,
): string {
  const vars = { PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: dataRoot };
  return value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, key) => {
    return vars[key as 'PLUGIN_ROOT' | 'PLUGIN_DATA'];
  });
}

function resolveDeclaredPath(
  value: string,
  pluginRoot: string,
  dataRoot: string,
): string | null {
  const expanded = expandPluginVars(value, pluginRoot, dataRoot);
  if (value.startsWith('${PLUGIN_ROOT}')) {
    return resolveContainedAbsolutePath(pluginRoot, expanded);
  }
  if (value.startsWith('${PLUGIN_DATA}')) {
    return resolveContainedAbsolutePath(dataRoot, expanded);
  }
  return expanded;
}

function expandArgs(
  args: string[] | undefined,
  pluginRoot: string,
  dataRoot: string,
): string[] {
  return (args ?? []).map((value) => expandPluginVars(value, pluginRoot, dataRoot));
}

function expandEnv(
  env: Record<string, string> | undefined,
  pluginRoot: string,
  dataRoot: string,
): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    expanded[key] = expandPluginVars(value, pluginRoot, dataRoot);
  }
  return expanded;
}

function commandLabel(command: string): string {
  return path.basename(command);
}

function invalidCommandToken(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function resolveCommand(pluginRoot: string, command: string): string | null {
  if (command.startsWith('./')) return resolveContainedRelativePath(pluginRoot, command);
  return invalidCommandToken(command) ? null : command;
}

function resolveWorkingDirectory(
  pluginRoot: string,
  dataRoot: string,
  cwd?: string,
): string | null {
  if (!cwd) return pluginRoot;
  if (cwd.startsWith('./')) return resolveContainedRelativePath(pluginRoot, cwd);
  return resolveDeclaredPath(cwd, pluginRoot, dataRoot);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopbackHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname);
  if (host === 'localhost') return true;
  if (net.isIP(host) === 4) return host.startsWith('127.');
  if (net.isIP(host) !== 6) return false;
  return host === '::1' || host.toLowerCase() === '0:0:0:0:0:0:0:1';
}

function validRemoteProtocol(parsed: URL): boolean {
  return parsed.protocol === 'https:'
    || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname));
}

function hasRestrictedUrlParts(parsed: URL): boolean {
  return Boolean(parsed.username || parsed.password || parsed.hash);
}

function remoteUrlAllowed(parsed: URL): boolean {
  return validRemoteProtocol(parsed) && !hasRestrictedUrlParts(parsed);
}

function validateRemoteUrl(urlText: string): URL | null {
  try {
    const parsed = new URL(urlText);
    return remoteUrlAllowed(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function uniqueHeaderKey(seen: Set<string>, key: string): boolean {
  const lowered = key.toLowerCase();
  if (seen.has(lowered)) return false;
  seen.add(lowered);
  return true;
}

function validHeaderPair(key: string, value: string): boolean {
  try {
    validateHeaderName(key);
    validateHeaderValue(key, value);
    return true;
  } catch {
    return false;
  }
}

function acceptHeader(
  seen: Set<string>,
  key: string,
  value: string,
): boolean {
  return uniqueHeaderKey(seen, key) && validHeaderPair(key, value);
}

function headerKeys(headers: Record<string, string> | undefined): string[] | null {
  const values = headers ?? {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    if (!acceptHeader(seen, key, value)) return null;
  }
  return Object.keys(values).sort();
}

function stdioServer(
  pluginRoot: string,
  dataRoot: string,
  name: string,
  server: Extract<PortableMcpServer, { type: 'stdio' }>,
): PluginMcpServer | null {
  const command = resolveCommand(pluginRoot, server.command);
  const args = expandArgs(server.args, pluginRoot, dataRoot);
  const env = expandEnv(server.env, pluginRoot, dataRoot);
  const cwd = resolveWorkingDirectory(pluginRoot, dataRoot, server.cwd);
  if (!command || !cwd) return null;
  return attachPluginMcpRuntime({
    name,
    type: 'stdio',
    summary: {
      command: commandLabel(command),
      argsCount: args.length,
      envKeys: Object.keys(env).sort(),
    },
  }, { command, args, env, cwd });
}

function remoteServer(
  name: string,
  server: Extract<PortableMcpServer, { type: 'streamable-http' | 'sse' }>,
): PluginMcpServer | null {
  const url = validateRemoteUrl(server.url);
  const keys = headerKeys(server.headers);
  if (!url || !keys) return null;
  return attachPluginMcpRuntime({
    name,
    type: server.type,
    summary: { origin: url.origin, headerKeys: keys },
  }, { url: server.url, headers: server.headers ?? {} });
}

function normalizeServer(
  pluginRoot: string,
  dataRoot: string,
  name: string,
  server: PortableMcpServer,
): PluginMcpServer | null {
  if (server.type === 'stdio') return stdioServer(pluginRoot, dataRoot, name, server);
  return remoteServer(name, server);
}

function readMcpText(pluginRoot: string): { text?: string; issue?: PluginCatalogIssue } {
  const mcpPath = path.join(pluginRoot, 'mcp.json');
  if (!lstatExists(mcpPath)) return {};
  const contained = resolveContainedAbsolutePath(pluginRoot, mcpPath);
  if (!contained || !isRegularFile(contained)) {
    return { issue: makeIssue('mcp_invalid', 'mcp', 'mcp.json', 'mcp.json must be a regular file inside the plugin root') };
  }
  try {
    return { text: fs.readFileSync(contained, 'utf8') };
  } catch {
    return { issue: makeIssue('mcp_invalid', 'mcp', 'mcp.json', 'mcp.json could not be read') };
  }
}

function schemaVersion(schema: string): string {
  return schema.match(/\/schemas\/([^/]+)\//)?.[1] ?? '';
}

function parseEnvelope(
  text: string,
  manifestSchema: string,
): { value?: { mcpServers: Record<string, unknown> }; issue?: PluginCatalogIssue } {
  try {
    const raw = JSON.parse(text);
    const parsed = portableMcpEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      return { issue: makeIssue('mcp_invalid', 'mcp', 'mcp.json', zodIssueText(parsed.error)) };
    }
    if (schemaVersion(parsed.data.$schema) !== schemaVersion(manifestSchema)) {
      return { issue: makeIssue('mcp_invalid', 'mcp', 'mcp.json', 'mcp.json schema does not match plugin.json') };
    }
    return { value: parsed.data };
  } catch {
    return { issue: makeIssue('mcp_invalid', 'mcp', 'mcp.json', 'mcp.json is not valid JSON') };
  }
}

function loadServers(
  pluginRoot: string,
  dataRoot: string,
  servers: Record<string, unknown>,
): { servers: PluginMcpServer[]; issues: PluginCatalogIssue[] } {
  const loaded: PluginMcpServer[] = [];
  const issues: PluginCatalogIssue[] = [];
  for (const [name, value] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    const parsed = portableMcpServerSchema.safeParse(value);
    if (!parsed.success) {
      issues.push(makeIssue('mcp_server_invalid', 'server', `mcpServers.${name}`, zodIssueText(parsed.error)));
      continue;
    }
    const server = normalizeServer(pluginRoot, dataRoot, name, parsed.data);
    if (!server) {
      issues.push(makeIssue('mcp_server_invalid', 'server', `mcpServers.${name}`, 'server violates URL or containment rules'));
      continue;
    }
    loaded.push(server);
  }
  return { servers: loaded, issues };
}

export function loadPortableMcpCatalog(
  pluginId: string,
  pluginRoot: string,
  dataDir: string,
  manifestSchema: string,
): PluginMcpLoadResult {
  const source = readMcpText(pluginRoot);
  if (source.issue) return { status: 'invalid', servers: [], issues: [source.issue] };
  if (source.text === undefined) return { status: 'missing', servers: [], issues: [] };
  const envelope = parseEnvelope(source.text, manifestSchema);
  if (envelope.issue || !envelope.value) {
    return { status: 'invalid', servers: [], issues: envelope.issue ? [envelope.issue] : [] };
  }
  const loaded = loadServers(pluginRoot, pluginDataDir(dataDir, pluginId), envelope.value.mcpServers);
  return { status: 'valid', servers: loaded.servers, issues: loaded.issues };
}
