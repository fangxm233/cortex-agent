// input:  selected plugin roots and backend policy
// output: backend paths, MCP configs, and fingerprint
// pos:    Shared spawn-time portable plugin resolver
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from '@core/paths.js';
import type { Backend, McpComposition, McpServerConfig } from '../../agent-adapter/types.js';
import { atomicWriteSync } from '../../core/atomic-write.js';
import { loadPluginCatalog } from './catalog.js';
import { pluginMcpRuntime, type PluginCatalogEntry, type PluginMcpServer } from './catalog-types.js';
import { safeClaudeManifestName, safeClaudeManifestVersion, safeNativeComposite } from './native-name.js';
import {
  buildProjectedSkillTree,
  copyProjectedSkillTree,
  type ProjectedSkillTree,
  validateProjectedSkillTree,
} from './skill-projection.js';

export interface ResolvePluginRuntimeOptions {
  backend: Backend;
  selectedPluginDirs?: string[] | null;
  mcpComposition?: McpComposition;
  dataDir?: string;
  pluginsDir?: string;
  runtimeDir?: string;
}

export interface ResolvedPluginRuntime {
  pluginDirs?: string[];
  pluginSkillDirs?: string[];
  mcpServers?: McpServerConfig[];
  pluginCapabilityFingerprint?: string;
}

interface CatalogRootInfo {
  absolute: string;
  real: string;
}

interface PortableSelection {
  entry: PluginCatalogEntry;
  root: CatalogRootInfo;
}

interface PortableSkillDetail {
  name: string;
  target: string;
  contentSha256: string;
  tree: ProjectedSkillTree;
}

interface PortableRuntimeDetail {
  namespace: string;
  skills: PortableSkillDetail[];
  projectionDir: string;
  mcpServers: McpServerConfig[];
}

type SelectedRuntimeItem =
  | { kind: 'portable'; id: string }
  | { kind: 'preserved'; path: string };

interface ClassifiedSelections {
  items: SelectedRuntimeItem[];
  portableSelections: Map<string, PortableSelection>;
  selectedLegacySkillNames: string[];
}

function stablePrimitive(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function stableArray(value: unknown[]): string {
  return `[${value.map((entry) => stableJson(entry) ?? 'null').join(',')}]`;
}

function stableObject(value: Record<string, unknown>): string {
  const members = Object.keys(value).sort()
    .flatMap((key) => {
      const entry = stableJson(value[key]);
      return entry === undefined ? [] : [`${JSON.stringify(key)}:${entry}`];
    });
  return `{${members.join(',')}}`;
}

function stableJson(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return stablePrimitive(value);
  if (Array.isArray(value)) return stableArray(value);
  return stableObject(value as Record<string, unknown>);
}

function stableSha256(value: unknown): string {
  const text = stableJson(value);
  if (text === undefined) throw new TypeError('Value is not JSON-serializable');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function definedArray(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined;
}

function realpathIfExists(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function selectedPath(dataDir: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(dataDir, value);
}

function portableMcpEnabled(composition: McpComposition | undefined): boolean {
  return composition !== 'none' && composition !== 'benchmark-thread-run';
}

function catalogRoots(
  pluginsDir: string,
  entries: readonly PluginCatalogEntry[],
): Map<string, CatalogRootInfo> {
  const roots = new Map<string, CatalogRootInfo>();
  for (const entry of entries) {
    const absolute = path.resolve(pluginsDir, entry.id);
    roots.set(entry.id, { absolute, real: realpathIfExists(absolute) ?? absolute });
  }
  return roots;
}

function catalogEntriesByPath(
  entries: PluginCatalogEntry[],
  roots: Map<string, CatalogRootInfo>,
): { byAbsolute: Map<string, PluginCatalogEntry>; byRealpath: Map<string, PluginCatalogEntry> } {
  const byAbsolute = new Map<string, PluginCatalogEntry>();
  const byRealpath = new Map<string, PluginCatalogEntry>();
  for (const entry of entries) {
    const root = roots.get(entry.id);
    if (!root) continue;
    byAbsolute.set(root.absolute, entry);
    byRealpath.set(root.real, entry);
  }
  return { byAbsolute, byRealpath };
}

function portableNamespace(entry: PluginCatalogEntry): string {
  return safeClaudeManifestName(entry.manifest.name?.trim() || entry.id);
}

function portableRuntimeName(entry: PluginCatalogEntry, serverName: string): string {
  return safeNativeComposite([entry.id, serverName], 'plugin');
}

function stdioServerConfig(
  entry: PluginCatalogEntry,
  server: PluginMcpServer,
  runtime: NonNullable<ReturnType<typeof pluginMcpRuntime>>,
  name: string,
): McpServerConfig {
  if (!('command' in runtime) || !('cwd' in runtime)) {
    throw new Error(`Portable MCP runtime mismatch for '${entry.id}/${server.name}'`);
  }
  const dataRoot = runtime.env.PLUGIN_DATA;
  if (!dataRoot) throw new Error(`Portable MCP PLUGIN_DATA missing for '${entry.id}/${server.name}'`);
  ensurePrivateDirectory(dataRoot, 'Portable plugin data');
  return {
    name, type: 'stdio', command: runtime.command,
    args: [...runtime.args], env: { ...runtime.env }, cwd: runtime.cwd,
  };
}

function serverConfig(entry: PluginCatalogEntry, server: PluginMcpServer): McpServerConfig {
  const runtime = pluginMcpRuntime(server);
  if (!runtime) throw new Error(`Portable MCP runtime missing for '${entry.id}/${server.name}'`);
  const name = portableRuntimeName(entry, server.name);
  if (server.type === 'stdio') return stdioServerConfig(entry, server, runtime, name);
  if (!('url' in runtime)) throw new Error(`Portable MCP runtime mismatch for '${entry.id}/${server.name}'`);
  return { name, type: server.type, url: runtime.url, headers: { ...runtime.headers } };
}

function portableSkills(selection: PortableSelection): PortableSkillDetail[] {
  return selection.entry.skills.map((skill) => {
    const target = realpathIfExists(path.join(selection.root.real, skill.dir)) ?? path.join(selection.root.real, skill.dir);
    const tree = buildProjectedSkillTree(selection.root.real, target);
    return {
      name: skill.name,
      target,
      contentSha256: tree.sha256,
      tree,
    };
  });
}

function projectionDescriptor(selection: PortableSelection, skills: PortableSkillDetail[]): string {
  return stableSha256({
    pluginId: selection.entry.id,
    manifest: projectionManifest(selection.entry),
    skills: skills.map((skill) => ({ name: skill.name, sha256: skill.contentSha256 })),
  });
}

function projectionManifest(entry: PluginCatalogEntry): string {
  const version = safeClaudeManifestVersion(entry.manifest.version);
  return `${JSON.stringify({
    name: portableNamespace(entry),
    ...(version ? { version } : {}),
    ...(entry.manifest.description ? { description: entry.manifest.description } : {}),
  }, null, 2)}\n`;
}

function assertNoSymlinkAncestors(directory: string, label: string): void {
  let current = path.resolve(directory);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} has a symlink ancestor: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ensurePrivateDirectory(directory: string, label: string): void {
  const resolved = path.resolve(directory);
  assertNoSymlinkAncestors(resolved, label);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(resolved, label);
  if (fs.realpathSync(resolved) !== resolved) throw new Error(`${label} is not physical: ${resolved}`);
  fs.chmodSync(resolved, 0o700);
}

function exactDirEntries(directory: string): string[] {
  return fs.readdirSync(directory).sort((left, right) => left.localeCompare(right));
}

function assertPhysicalDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Claude projection target is invalid: ${directory}`);
  }
}

function assertExactEntries(directory: string, expected: string[], label: string): void {
  if (stableJson(exactDirEntries(directory)) !== stableJson(expected)) {
    throw new Error(`Claude projection ${label} mismatch: ${directory}`);
  }
}

function validateProjectionManifest(target: string, manifestText: string): void {
  const manifestDir = path.join(target, '.claude-plugin');
  assertPhysicalDirectory(manifestDir);
  assertExactEntries(manifestDir, ['plugin.json'], 'manifest directory');
  if (fs.readFileSync(path.join(manifestDir, 'plugin.json'), 'utf8') !== manifestText) {
    throw new Error(`Claude projection manifest mismatch: ${target}`);
  }
}

function validateProjectionSkills(target: string, skills: PortableSkillDetail[]): void {
  const skillsRoot = path.join(target, 'skills');
  assertPhysicalDirectory(skillsRoot);
  const expected = skills.map((skill) => skill.name).sort((left, right) => left.localeCompare(right));
  assertExactEntries(skillsRoot, expected, 'skill set');
  for (const skill of skills) {
    validateProjectedSkillTree(path.join(skillsRoot, skill.name), skill.tree);
  }
}

function validateProjectionTarget(
  target: string,
  manifestText: string,
  skills: PortableSkillDetail[],
): void {
  assertPhysicalDirectory(target);
  assertExactEntries(target, ['.claude-plugin', 'skills'], 'root');
  validateProjectionManifest(target, manifestText);
  validateProjectionSkills(target, skills);
}

function secureProjectionTree(target: string): void {
  ensurePrivateDirectory(target, 'Claude projection');
  ensurePrivateDirectory(path.join(target, '.claude-plugin'), 'Claude projection');
  ensurePrivateDirectory(path.join(target, 'skills'), 'Claude projection');
}

function writeProjection(
  packageRoot: string,
  tmp: string,
  manifestText: string,
  skills: PortableSkillDetail[],
): void {
  secureProjectionTree(tmp);
  atomicWriteSync(path.join(tmp, '.claude-plugin', 'plugin.json'), manifestText);
  for (const skill of skills) {
    copyProjectedSkillTree(packageRoot, skill.target, skill.tree, path.join(tmp, 'skills', skill.name));
  }
}

function projectionTarget(parent: string, selection: PortableSelection, skills: PortableSkillDetail[]): string {
  const descriptor = projectionDescriptor(selection, skills);
  return path.join(parent, safeNativeComposite([selection.entry.id, descriptor], 'plugin'));
}

function projectionTemp(parent: string, target: string): string {
  const nonce = `${process.pid}:${Date.now()}:${Math.random()}`;
  return path.join(parent, safeNativeComposite([path.basename(target), nonce], 'plugin_tmp'));
}

function createProjectionTarget(
  selection: PortableSelection,
  skills: PortableSkillDetail[],
  manifestText: string,
  target: string,
): boolean {
  const tmp = projectionTemp(path.dirname(target), target);
  fs.mkdirSync(tmp, { mode: 0o700 });
  try {
    writeProjection(selection.root.real, tmp, manifestText, skills);
    fs.renameSync(tmp, target);
    return true;
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(target)) throw error;
    return false;
  }
}

function validateReadyProjection(target: string, manifestText: string, skills: PortableSkillDetail[]): string {
  validateProjectionTarget(target, manifestText, skills);
  secureProjectionTree(target);
  return target;
}

function ensureClaudeProjection(
  selection: PortableSelection,
  skills: PortableSkillDetail[],
  runtimeDir: string,
): string {
  ensurePrivateDirectory(runtimeDir, 'Plugin runtime');
  const parent = path.join(runtimeDir, 'claude');
  ensurePrivateDirectory(parent, 'Claude projection');
  const manifestText = projectionManifest(selection.entry);
  const target = projectionTarget(parent, selection, skills);
  if (fs.existsSync(target)) return validateReadyProjection(target, manifestText, skills);
  const createdTarget = createProjectionTarget(selection, skills, manifestText, target);
  try {
    return validateReadyProjection(target, manifestText, skills);
  } catch (error) {
    if (createdTarget) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function portableRuntimeDetail(
  selection: PortableSelection,
  backend: Backend,
  runtimeDir: string,
  includePortableMcp: boolean,
): PortableRuntimeDetail {
  const skills = portableSkills(selection);
  return {
    namespace: portableNamespace(selection.entry),
    skills,
    projectionDir: backend === 'claude' ? ensureClaudeProjection(selection, skills, runtimeDir) : '',
    mcpServers: includePortableMcp ? selection.entry.mcp.servers.map((server) => serverConfig(selection.entry, server)) : [],
  };
}

function fingerprint(
  backend: Backend,
  items: readonly SelectedRuntimeItem[],
  details: ReadonlyMap<string, PortableRuntimeDetail>,
  pluginDirs: string[] | undefined,
  pluginSkillDirs: string[] | undefined,
  mcpServers: McpServerConfig[] | undefined,
): string | undefined {
  if (!pluginDirs && !pluginSkillDirs && !mcpServers) return undefined;
  return stableSha256({
    backend,
    pluginDirs: pluginDirs ?? [],
    pluginSkillDirs: pluginSkillDirs ?? [],
    mcpServers: mcpServers ?? [],
    selected: items.map((item) => item.kind === 'preserved'
      ? { kind: item.kind, path: item.path }
      : {
          kind: item.kind,
          id: item.id,
          skills: details.get(item.id)?.skills.map((skill) => ({
            name: skill.name,
            target: skill.target,
            contentSha256: skill.contentSha256,
          })) ?? [],
        }),
  });
}

function requiredPortableRoot(
  roots: ReadonlyMap<string, CatalogRootInfo>,
  id: string,
): CatalogRootInfo {
  const root = roots.get(id);
  if (!root) throw new Error(`Portable plugin root missing for '${id}'`);
  return root;
}

function addPortableSelection(
  entry: PluginCatalogEntry,
  roots: ReadonlyMap<string, CatalogRootInfo>,
  result: ClassifiedSelections,
): void {
  if (!entry.valid) throw new Error(`Assigned portable plugin '${entry.id}' is invalid`);
  if (result.portableSelections.has(entry.id)) return;
  const root = requiredPortableRoot(roots, entry.id);
  result.portableSelections.set(entry.id, { entry, root });
  result.items.push({ kind: 'portable', id: entry.id });
}

function addClassifiedSelection(
  absolute: string,
  real: string | null,
  entry: PluginCatalogEntry | undefined,
  roots: ReadonlyMap<string, CatalogRootInfo>,
  result: ClassifiedSelections,
  preserved: Set<string>,
): void {
  if (entry?.kind === 'portable') return addPortableSelection(entry, roots, result);
  if (entry?.kind === 'legacy') {
    result.selectedLegacySkillNames.push(...entry.skills.map((skill) => skill.name));
  }
  const preservedPath = real ?? absolute;
  if (preserved.has(preservedPath)) return;
  preserved.add(preservedPath);
  result.items.push({ kind: 'preserved', path: preservedPath });
}

function classifySelections(
  entries: PluginCatalogEntry[],
  roots: Map<string, CatalogRootInfo>,
  dataDir: string,
  selectedPluginDirs: string[],
): ClassifiedSelections {
  const lookup = catalogEntriesByPath(entries, roots);
  const result: ClassifiedSelections = {
    items: [], portableSelections: new Map(), selectedLegacySkillNames: [],
  };
  const preserved = new Set<string>();
  for (const value of selectedPluginDirs) {
    const absolute = selectedPath(dataDir, value);
    const real = realpathIfExists(absolute);
    const entry = lookup.byAbsolute.get(absolute) ?? (real ? lookup.byRealpath.get(real) : undefined);
    addClassifiedSelection(absolute, real, entry, roots, result, preserved);
  }
  return result;
}

function addUniqueName(seen: Set<string>, name: string, label: string): void {
  if (seen.has(name)) throw new Error(`Duplicate portable ${label}: ${name}`);
  seen.add(name);
}

function collectSkillNames(detail: PortableRuntimeDetail, skillNames: Set<string>): void {
  for (const skill of detail.skills) addUniqueName(skillNames, skill.name, 'skill name');
}

function collectMcpNames(detail: PortableRuntimeDetail, mcpNames: Set<string>): void {
  for (const server of detail.mcpServers) addUniqueName(mcpNames, server.name, 'MCP namespace');
}

function collectPortableDetails(
  portableSelections: ReadonlyMap<string, PortableSelection>,
  backend: Backend,
  runtimeDir: string,
  includePortableMcp: boolean,
): { details: Map<string, PortableRuntimeDetail>; skillNames: Set<string> } {
  const details = new Map<string, PortableRuntimeDetail>();
  const namespaces = new Set<string>();
  const skillNames = new Set<string>();
  const mcpNames = new Set<string>();
  for (const [id, selection] of portableSelections) {
    const detail = portableRuntimeDetail(selection, backend, runtimeDir, includePortableMcp);
    addUniqueName(namespaces, detail.namespace, 'MCP namespace');
    collectSkillNames(detail, skillNames);
    collectMcpNames(detail, mcpNames);
    details.set(id, detail);
  }
  return { details, skillNames };
}

function assertLegacySkillCollisions(skillNames: ReadonlySet<string>, legacySkillNames: readonly string[]): void {
  for (const name of legacySkillNames) {
    if (skillNames.has(name)) throw new Error(`Duplicate portable skill name: ${name}`);
  }
}

interface RuntimePaths {
  pluginDirs: string[];
  pluginSkillDirs: string[];
  mcpServers: McpServerConfig[];
}

function addPortablePaths(detail: PortableRuntimeDetail, backend: Backend, paths: RuntimePaths): void {
  if (backend === 'claude') paths.pluginDirs.push(detail.projectionDir);
  else paths.pluginSkillDirs.push(...detail.skills.map(skill => skill.target));
  paths.mcpServers.push(...detail.mcpServers);
}

function addRuntimeItem(
  item: SelectedRuntimeItem,
  details: ReadonlyMap<string, PortableRuntimeDetail>,
  backend: Backend,
  paths: RuntimePaths,
): void {
  if (item.kind === 'preserved') return void paths.pluginDirs.push(item.path);
  const detail = details.get(item.id);
  if (detail) addPortablePaths(detail, backend, paths);
}

function resolveRuntimePaths(
  items: readonly SelectedRuntimeItem[],
  details: ReadonlyMap<string, PortableRuntimeDetail>,
  backend: Backend,
): RuntimePaths {
  const paths: RuntimePaths = { pluginDirs: [], pluginSkillDirs: [], mcpServers: [] };
  for (const item of items) addRuntimeItem(item, details, backend, paths);
  return paths;
}

function resolvedRuntime(
  backend: Backend,
  items: readonly SelectedRuntimeItem[],
  details: ReadonlyMap<string, PortableRuntimeDetail>,
): ResolvedPluginRuntime {
  const paths = resolveRuntimePaths(items, details, backend);
  const pluginDirs = definedArray(paths.pluginDirs);
  const pluginSkillDirs = backend === 'pi' ? definedArray(paths.pluginSkillDirs) : undefined;
  const mcpServers = paths.mcpServers.length > 0 ? paths.mcpServers : undefined;
  return {
    pluginDirs,
    pluginSkillDirs,
    mcpServers,
    pluginCapabilityFingerprint: fingerprint(backend, items, details, pluginDirs, pluginSkillDirs, mcpServers),
  };
}

export function resolvePluginRuntime(options: ResolvePluginRuntimeOptions): ResolvedPluginRuntime {
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  const pluginsDir = path.resolve(options.pluginsDir ?? PLUGINS_DIR);
  const runtimeDir = path.resolve(options.runtimeDir ?? path.join(dataDir, 'data', 'plugin-runtime'));
  const selectedPluginDirs = (options.selectedPluginDirs ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (selectedPluginDirs.length === 0) return {};
  const entries = loadPluginCatalog({ pluginsDir, dataDir });
  const classified = classifySelections(entries, catalogRoots(pluginsDir, entries), dataDir, selectedPluginDirs);
  if (classified.items.length === 0) return {};
  const portable = collectPortableDetails(
    classified.portableSelections, options.backend, runtimeDir, portableMcpEnabled(options.mcpComposition),
  );
  assertLegacySkillCollisions(portable.skillNames, classified.selectedLegacySkillNames);
  return resolvedRuntime(options.backend, classified.items, portable.details);
}
