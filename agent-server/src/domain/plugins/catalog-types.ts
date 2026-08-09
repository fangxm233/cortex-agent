// input:  none
// output: public catalog DTOs and private MCP runtime carriers
// pos:    Shared result types for plugin catalog loading
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export type PluginCatalogKind = 'portable' | 'legacy' | 'unknown';
export type PluginCatalogManifestSource = 'root' | 'legacy' | 'none';
export type PluginMcpStatus = 'missing' | 'valid' | 'invalid';

export type PluginCatalogIssueCode =
  | 'legacy_manifest_invalid'
  | 'manifest_extensions_ignored'
  | 'manifest_invalid'
  | 'manifest_missing'
  | 'manifest_unknown_field'
  | 'mcp_invalid'
  | 'mcp_server_invalid'
  | 'plugin_root_not_directory'
  | 'plugin_root_outside_plugins_dir'
  | 'skill_invalid'
  | 'skill_outside_plugin_root';

export interface PluginCatalogIssue {
  code: PluginCatalogIssueCode;
  scope: 'plugin' | 'manifest' | 'skill' | 'mcp' | 'server';
  path: string | null;
  message: string;
}

export interface PluginCatalogManifest {
  source: PluginCatalogManifestSource;
  name?: string;
  schema?: string;
  version?: string;
  description?: string;
}

export interface PluginCatalogSkill {
  name: string;
  dir: string;
}

export interface PluginMcpStdioSummary {
  command: string;
  argsCount: number;
  envKeys: string[];
}

export interface PluginMcpRemoteSummary {
  origin: string;
  headerKeys: string[];
}

export interface PluginMcpStdioServer {
  name: string;
  type: 'stdio';
  summary: PluginMcpStdioSummary;
}

export interface PluginMcpRemoteServer {
  name: string;
  type: 'streamable-http' | 'sse';
  summary: PluginMcpRemoteSummary;
}

export type PluginMcpServer = PluginMcpStdioServer | PluginMcpRemoteServer;

export interface PluginMcpStdioRuntime {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface PluginMcpRemoteRuntime {
  url: string;
  headers: Record<string, string>;
}

export type PluginMcpRuntime = PluginMcpStdioRuntime | PluginMcpRemoteRuntime;

export const PLUGIN_MCP_RUNTIME = Symbol('pluginMcpRuntime');

type RuntimeCarrier = { [PLUGIN_MCP_RUNTIME]?: PluginMcpRuntime };

export function attachPluginMcpRuntime<T extends PluginMcpServer>(
  server: T,
  runtime: PluginMcpRuntime,
): T {
  Object.defineProperty(server, PLUGIN_MCP_RUNTIME, {
    value: runtime,
    enumerable: false,
  });
  return server;
}

export function pluginMcpRuntime(
  server: PluginMcpServer,
): PluginMcpRuntime | null {
  return (server as RuntimeCarrier)[PLUGIN_MCP_RUNTIME] ?? null;
}

export interface PluginCatalogMcp {
  status: PluginMcpStatus;
  servers: PluginMcpServer[];
}

export interface PluginCatalogEntry {
  id: string;
  kind: PluginCatalogKind;
  rootDir: string;
  valid: boolean;
  manifest: PluginCatalogManifest;
  skills: PluginCatalogSkill[];
  mcp: PluginCatalogMcp;
  issues: PluginCatalogIssue[];
}
