import type { LayerOrigin } from '@core/builtin-layer.js';
import { safeClaudeManifestName } from '@core/native-name.js';

export type PluginCatalogKind = 'portable' | 'legacy' | 'unknown';
export type PluginCatalogManifestSource = 'root' | 'legacy' | 'none';
export type PluginMcpStatus = 'missing' | 'valid' | 'invalid';

export type PluginCatalogIssueCode =
  | 'legacy_manifest_invalid'
  | 'manifest_extensions_ignored'
  | 'manifest_invalid'
  | 'manifest_missing'
  | 'manifest_name_duplicate'
  | 'manifest_unknown_field'
  | 'mcp_invalid'
  | 'mcp_server_invalid'
  | 'plugin_root_not_directory'
  | 'plugin_root_outside_plugins_dir'
  | 'skill_frontmatter_ignored'
  | 'skill_invalid'
  | 'skill_outside_plugin_root';

export interface PluginCatalogIssue {
  code: PluginCatalogIssueCode;
  scope: 'plugin' | 'manifest' | 'skill' | 'mcp' | 'server';
  path: string | null;
  message: string;
}

export function makeIssue(
  code: PluginCatalogIssue['code'],
  scope: PluginCatalogIssue['scope'],
  filePath: string | null,
  message: string,
): PluginCatalogIssue {
  return { code, scope, path: filePath, message };
}

/** Render a zod issue path as `a.b[0]`. */
export function formatPath(parts: ReadonlyArray<PropertyKey>): string {
  return parts.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    return text ? `${text}.${String(part)}` : String(part);
  }, '');
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
  /** The frontmatter `description`, trimmed. Always present: an empty description is fatal, so a
   *  loaded skill always has one. Carried here so a UI can list skills without re-reading each file. */
  description: string;
  /** `builtin` as shipped, `overridden` by the user's skill of the same name, `local` the user's own. */
  origin: LayerOrigin;
}

/** A skill as read from its SKILL.md, before the catalog places it in a layer. */
export type PluginSkillFile = Pick<PluginCatalogSkill, 'name' | 'dir' | 'description'>;

const SKILL_ROOT = Symbol('skillRoot');

type SkillRootCarrier = { [SKILL_ROOT]?: string };

/** A skill placed in the plugin layer it is read from: the built-in plugin in the install, or the
 *  user's `plugins/<id>`. The layer's real path (`dir` is relative to it) is kept off the enumerable
 *  shape, like the MCP runtime below, so a catalog entry carries no host paths. */
export function placeSkill(skill: PluginSkillFile, root: string, origin: LayerOrigin): PluginCatalogSkill {
  const placed: PluginCatalogSkill = { name: skill.name, dir: skill.dir, description: skill.description, origin };
  Object.defineProperty(placed, SKILL_ROOT, { value: root, enumerable: false });
  return placed;
}

export function skillRoot(skill: PluginCatalogSkill): string | null {
  return (skill as SkillRootCarrier)[SKILL_ROOT] ?? null;
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

const PLUGIN_MCP_RUNTIME = Symbol('pluginMcpRuntime');

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
  /** `builtin` when Cortex ships the plugin: its manifest is the shipped one, and the user's
   *  `plugins/<id>` only adds or replaces skills (and `mcp.json`). */
  origin: 'builtin' | 'local';
  kind: PluginCatalogKind;
  rootDir: string;
  valid: boolean;
  manifest: PluginCatalogManifest;
  skills: PluginCatalogSkill[];
  mcp: PluginCatalogMcp;
  issues: PluginCatalogIssue[];
}

/** The name a portable plugin goes by in a Claude projection (`<namespace>:<skill>`). */
export function portableNamespace(entry: Pick<PluginCatalogEntry, 'id' | 'manifest'>): string {
  return safeClaudeManifestName(entry.manifest.name?.trim() || entry.id);
}
