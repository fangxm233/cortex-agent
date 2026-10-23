import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@core/log.js';
import { DATA_DIR, PLUGINS_DIR } from '@core/paths.js';
import type { Backend, McpComposition, McpServerConfig } from '../../agent-adapter/types.js';
import { atomicWriteSync } from '../../core/atomic-write.js';
import { ensurePrivateDirectory, physicalUnder } from '@core/private-dir.js';
import { loadPluginCatalog } from './catalog.js';
import { defaultBuiltinPluginsDir, listBuiltinPluginIds } from './builtin.js';
import {
  pluginMcpRuntime, portableNamespace, skillRoot, type PluginCatalogEntry, type PluginMcpServer,
} from './catalog-types.js';
import { listImmediateChildNames, realPath } from './fs-helpers.js';
import { markInUse, sweepStaleClaudeMcpFiles, sweepStaleRuntimeDirs } from './runtime-gc.js';
import { safeClaudeManifestVersion, safeNativeComposite } from '@core/native-name.js';
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
  /** The built-in plugins under the user's; null leaves them out. Defaults as the catalog does. */
  builtinDir?: string | null;
  runtimeDir?: string;
}

export interface ResolvedPluginRuntime {
  pluginDirs?: string[];
  pluginSkillDirs?: string[];
  mcpServers?: McpServerConfig[];
  pluginCapabilityFingerprint?: string;
  /** Selected skills or MCP servers that failed to materialize and are missing from this spawn.
   *  Present only when something was dropped; the run tells the user, not just the log. */
  warnings?: string[];
}

interface CatalogRootInfo {
  absolute: string;
  real: string;
}

interface PortableSelection {
  entry: PluginCatalogEntry;
}

interface PortableSkillDetail {
  name: string;
  /** The plugin layer the skill is read from; its files must stay inside it. */
  root: string;
  target: string;
  contentSha256: string;
  tree: ProjectedSkillTree;
}

interface PortableRuntimeDetail {
  skills: PortableSkillDetail[];
  projectionDir: string | null;
  mcpServers: McpServerConfig[];
}

const log = createLogger('plugin-runtime');

/** A selected skill or MCP server that will be missing from the spawn. Logged, and collected for
 *  the run to surface: a session that silently starts without its skills looks healthy. */
function reportSkip(warnings: string[], message: string): void {
  log.warn(message);
  warnings.push(message);
}

type SelectedRuntimeItem =
  | { kind: 'portable'; id: string }
  | { kind: 'preserved'; path: string };

/** A skill offered by a selected legacy plugin, carried with its owner so a collision can name it. */
interface LegacySkillRef {
  name: string;
  pluginId: string;
}

interface ClassifiedSelections {
  items: SelectedRuntimeItem[];
  portableSelections: Map<string, PortableSelection>;
  selectedLegacySkills: LegacySkillRef[];
  warnings: string[];
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

function selectedPath(dataDir: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(dataDir, value);
}

function portableMcpEnabled(composition: McpComposition | undefined): boolean {
  return composition !== 'none';
}

function catalogRoots(
  pluginsDir: string,
  entries: readonly PluginCatalogEntry[],
): Map<string, CatalogRootInfo> {
  const roots = new Map<string, CatalogRootInfo>();
  for (const entry of entries) {
    const absolute = path.resolve(pluginsDir, entry.id);
    roots.set(entry.id, { absolute, real: realPath(absolute) ?? absolute });
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

function portableSkill(
  selection: PortableSelection,
  skill: PluginCatalogEntry['skills'][number],
  warnings: string[],
): PortableSkillDetail | null {
  try {
    const root = skillRoot(skill);
    if (!root) throw new Error('its plugin layer is unknown');
    const source = path.join(root, skill.dir);
    const target = realPath(source) ?? source;
    const tree = buildProjectedSkillTree(root, target);
    return { name: skill.name, root, target, contentSha256: tree.sha256, tree };
  } catch (error) {
    reportSkip(warnings, `Skipping portable skill '${selection.entry.id}/${skill.name}': ${(error as Error).message}`);
    return null;
  }
}

function portableSkills(selection: PortableSelection, warnings: string[]): PortableSkillDetail[] {
  return selection.entry.skills.flatMap((skill) => {
    const detail = portableSkill(selection, skill, warnings);
    return detail ? [detail] : [];
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
  tmp: string,
  manifestText: string,
  skills: PortableSkillDetail[],
): void {
  secureProjectionTree(tmp);
  atomicWriteSync(path.join(tmp, '.claude-plugin', 'plugin.json'), manifestText);
  for (const skill of skills) {
    copyProjectedSkillTree(skill.target, skill.target, skill.tree, path.join(tmp, 'skills', skill.name));
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
    writeProjection(tmp, manifestText, skills);
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

function skillSnapshotTarget(
  parent: string,
  selection: PortableSelection,
  skill: PortableSkillDetail,
): string {
  const descriptor = safeNativeComposite(
    [selection.entry.id, skill.name, skill.contentSha256], 'skill',
  );
  return path.join(parent, descriptor, skill.name);
}

function createSkillSnapshot(
  selection: PortableSelection,
  skill: PortableSkillDetail,
  target: string,
): boolean {
  const tmp = projectionTemp(path.dirname(target), target);
  try {
    copyProjectedSkillTree(skill.root, skill.target, skill.tree, tmp, { requireSourceSignature: true });
    fs.renameSync(tmp, target);
    return true;
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(target)) throw error;
    return false;
  }
}

function validateSkillSnapshot(target: string, skill: PortableSkillDetail): string {
  validateProjectedSkillTree(target, skill.tree);
  ensurePrivateDirectory(target, 'Portable skill snapshot');
  return target;
}

function ensureSkillSnapshot(
  selection: PortableSelection,
  skill: PortableSkillDetail,
  runtimeDir: string,
  backend: Backend,
): string {
  ensurePrivateDirectory(runtimeDir, 'Plugin runtime');
  const parent = path.join(runtimeDir, backend, 'skill-snapshots');
  ensurePrivateDirectory(parent, `${backend} skill snapshots`);
  const target = skillSnapshotTarget(parent, selection, skill);
  ensurePrivateDirectory(path.dirname(target), `${backend} skill snapshot`);
  if (fs.existsSync(target)) {
    markInUse(path.dirname(target));
    return validateSkillSnapshot(target, skill);
  }
  const createdTarget = createSkillSnapshot(selection, skill, target);
  try {
    return validateSkillSnapshot(target, skill);
  } catch (error) {
    if (createdTarget) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function materializedSkill(
  selection: PortableSelection,
  skill: PortableSkillDetail,
  runtimeDir: string,
  backend: Backend,
  warnings: string[],
): PortableSkillDetail | null {
  try {
    return { ...skill, target: ensureSkillSnapshot(selection, skill, runtimeDir, backend) };
  } catch (error) {
    reportSkip(warnings, `Skipping portable skill '${selection.entry.id}/${skill.name}': ${(error as Error).message}`);
    return null;
  }
}

function materializedSkills(
  selection: PortableSelection,
  skills: PortableSkillDetail[],
  runtimeDir: string,
  backend: Backend,
  warnings: string[],
): PortableSkillDetail[] {
  return skills.flatMap((skill) => {
    const detail = materializedSkill(selection, skill, runtimeDir, backend, warnings);
    return detail ? [detail] : [];
  });
}

function ensurePortableProjection(
  selection: PortableSelection,
  skills: PortableSkillDetail[],
  runtimeDir: string,
  backend: Backend,
): string {
  ensurePrivateDirectory(runtimeDir, 'Plugin runtime');
  const parent = path.join(runtimeDir, backend);
  ensurePrivateDirectory(parent, `${backend} plugin projection`);
  const manifestText = projectionManifest(selection.entry);
  const target = projectionTarget(parent, selection, skills);
  if (fs.existsSync(target)) {
    markInUse(target);
    return validateReadyProjection(target, manifestText, skills);
  }
  const createdTarget = createProjectionTarget(selection, skills, manifestText, target);
  try {
    return validateReadyProjection(target, manifestText, skills);
  } catch (error) {
    if (createdTarget) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function optionalProjection(
  selection: PortableSelection,
  skills: PortableSkillDetail[],
  runtimeDir: string,
  backend: Backend,
  warnings: string[],
): string | null {
  if (skills.length === 0) return null;
  try {
    return ensurePortableProjection(selection, skills, runtimeDir, backend);
  } catch (error) {
    reportSkip(warnings, `Skipping portable skills for '${selection.entry.id}': ${(error as Error).message}`);
    skills.splice(0);
    return null;
  }
}

function optionalServerConfig(
  entry: PluginCatalogEntry,
  server: PluginMcpServer,
  warnings: string[],
): McpServerConfig[] {
  try {
    return [serverConfig(entry, server)];
  } catch (error) {
    reportSkip(warnings, `Skipping portable MCP '${entry.id}/${server.name}': ${(error as Error).message}`);
    return [];
  }
}

function portableRuntimeDetail(
  selection: PortableSelection,
  backend: Backend,
  runtimeDir: string,
  includePortableMcp: boolean,
  claims: SkillClaims,
  warnings: string[],
): PortableRuntimeDetail {
  const skills = materializedSkills(
    selection, claimPortableSkills(selection, portableSkills(selection, warnings), claims), runtimeDir, backend, warnings,
  );
  return {
    skills,
    projectionDir: backend === 'claude'
      ? optionalProjection(selection, skills, runtimeDir, backend, warnings)
      : null,
    mcpServers: includePortableMcp
      ? selection.entry.mcp.servers.flatMap((server) => optionalServerConfig(selection.entry, server, warnings))
      : [],
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

function addPortableSelection(entry: PluginCatalogEntry, result: ClassifiedSelections): void {
  // Skipped, not fatal: one broken manifest must not stop every session that selects it from
  // starting. The catalog already lists the manifest issues on the plugin's page.
  if (!entry.valid) {
    const reason = entry.issues[0]?.message ?? 'manifest is invalid';
    reportSkip(result.warnings, `Skipping plugin '${entry.id}': its plugin.json is invalid (${reason})`);
    return;
  }
  if (result.portableSelections.has(entry.id)) return;
  result.portableSelections.set(entry.id, { entry });
  result.items.push({ kind: 'portable', id: entry.id });
}

function addClassifiedSelection(
  absolute: string,
  real: string | null,
  entry: PluginCatalogEntry | undefined,
  result: ClassifiedSelections,
  preserved: Set<string>,
): void {
  if (entry?.kind === 'portable') return addPortableSelection(entry, result);
  if (entry?.kind === 'legacy') {
    result.selectedLegacySkills.push(
      ...entry.skills.map((skill) => ({ name: skill.name, pluginId: entry.id })));
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
    items: [], portableSelections: new Map(), selectedLegacySkills: [], warnings: [],
  };
  const preserved = new Set<string>();
  for (const value of selectedPluginDirs) {
    const absolute = selectedPath(dataDir, value);
    const real = realPath(absolute);
    const entry = lookup.byAbsolute.get(absolute) ?? (real ? lookup.byRealpath.get(real) : undefined);
    addClassifiedSelection(absolute, real, entry, result, preserved);
  }
  return result;
}

/** Skill name -> the portable plugin id providing it. A second plugin offering the same name loses
 *  it: two skills answering to one name is a coin flip for the model, and the alternative — refusing
 *  to spawn at all — lets one stale directory turn every agent into a dead one. First selected wins,
 *  so pluginDirs order is the tie-break, which is a thing the operator can see and edit. */
type SkillClaims = Map<string, string>;

/** Keep only the skills whose names are still unclaimed, naming both sides of every drop so the
 *  loser is diagnosable from the log alone. */
function claimPortableSkills(
  selection: PortableSelection,
  skills: PortableSkillDetail[],
  claims: SkillClaims,
): PortableSkillDetail[] {
  const kept: PortableSkillDetail[] = [];
  for (const skill of skills) {
    const owner = claims.get(skill.name);
    if (owner !== undefined) {
      log.warn(`Skipping skill '${skill.name}' from plugin '${selection.entry.id}': `
        + `'${owner}' is already selected and provides that name.`);
      continue;
    }
    claims.set(skill.name, selection.entry.id);
    kept.push(skill);
  }
  return kept;
}

/** A failed projection empties a plugin's skill list after it staked its claims. Hand those names
 *  back, so a plugin that lost a name to one that ended up providing nothing can still supply it. */
function releaseUnusedClaims(
  claims: SkillClaims,
  pluginId: string,
  skills: readonly PortableSkillDetail[],
): void {
  const live = new Set(skills.map((skill) => skill.name));
  for (const [name, owner] of claims) {
    if (owner === pluginId && !live.has(name)) claims.delete(name);
  }
}

/** Server names are composed from the plugin id and the server's own key, both unique already;
 *  a collision here means the composition itself is broken, not that the operator erred. */
function assertUniqueMcpNames(detail: PortableRuntimeDetail, mcpNames: Set<string>): void {
  for (const server of detail.mcpServers) {
    if (mcpNames.has(server.name)) throw new Error(`Duplicate portable MCP server name: ${server.name}`);
    mcpNames.add(server.name);
  }
}

/** Plugin namespace -> the portable plugin id holding it. Claude Code addresses a plugin's skills as
 *  `<namespace>:<skill>`, so two selected plugins under one name are ambiguous. Same rule as a
 *  duplicated skill: the first selected keeps it and the later plugin is skipped whole, rather than
 *  failing every spawn of every session that selects both. The catalog reports the clash too. */
function claimNamespace(namespaces: Map<string, string>, selection: PortableSelection): boolean {
  const namespace = portableNamespace(selection.entry);
  const owner = namespaces.get(namespace);
  if (owner !== undefined) {
    log.warn(`Skipping plugin '${selection.entry.id}': its name '${namespace}' is already used by `
      + `selected plugin '${owner}'.`);
    return false;
  }
  namespaces.set(namespace, selection.entry.id);
  return true;
}

function collectPortableDetails(
  portableSelections: ReadonlyMap<string, PortableSelection>,
  backend: Backend,
  runtimeDir: string,
  includePortableMcp: boolean,
): { details: Map<string, PortableRuntimeDetail>; skillClaims: SkillClaims; warnings: string[] } {
  const details = new Map<string, PortableRuntimeDetail>();
  const namespaces = new Map<string, string>();
  const claims: SkillClaims = new Map();
  const mcpNames = new Set<string>();
  const warnings: string[] = [];
  for (const [id, selection] of portableSelections) {
    if (!claimNamespace(namespaces, selection)) continue;
    const detail = portableRuntimeDetail(selection, backend, runtimeDir, includePortableMcp, claims, warnings);
    releaseUnusedClaims(claims, id, detail.skills);
    assertUniqueMcpNames(detail, mcpNames);
    details.set(id, detail);
  }
  return { details, skillClaims: claims, warnings };
}

/** A legacy plugin is handed to the backend as a whole directory, so a single skill cannot be
 *  dropped out of it the way a portable one can. Report the overlap and let the backend resolve it:
 *  PI takes the first skill path, which is the portable copy, and Claude Code keeps both apart under
 *  their `<plugin>:<skill>` identities. */
function warnLegacySkillCollisions(claims: SkillClaims, legacySkills: readonly LegacySkillRef[]): void {
  for (const { name, pluginId } of legacySkills) {
    const owner = claims.get(name);
    if (owner === undefined) continue;
    log.warn(`Skill '${name}' is provided by both portable plugin '${owner}' and legacy plugin `
      + `'${pluginId}'. Deselect one of them to make the choice explicit.`);
  }
}

interface RuntimePaths {
  pluginDirs: string[];
  pluginSkillDirs: string[];
  mcpServers: McpServerConfig[];
}

function addPortablePaths(detail: PortableRuntimeDetail, backend: Backend, paths: RuntimePaths): void {
  if (backend === 'claude' && detail.projectionDir) paths.pluginDirs.push(detail.projectionDir);
  if (backend === 'pi') paths.pluginSkillDirs.push(...detail.skills.map((skill) => skill.target));
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

/** Catalog ids the selection names (by path or realpath), so the catalog loads only those. A
 *  built-in plugin is selected by its `plugins/<id>` address, whether or not the user has a layer. */
function selectedCatalogIds(
  pluginsDir: string, dataDir: string, selectedPluginDirs: readonly string[], builtinIds: readonly string[],
): Set<string> {
  const wanted = new Set<string>();
  for (const value of selectedPluginDirs) {
    const absolute = selectedPath(dataDir, value);
    wanted.add(absolute);
    const real = realPath(absolute);
    if (real) wanted.add(real);
  }
  const ids = new Set<string>();
  for (const id of new Set([...listImmediateChildNames(pluginsDir), ...builtinIds])) {
    const absolute = path.resolve(pluginsDir, id);
    if (wanted.has(absolute) || wanted.has(realPath(absolute) ?? absolute)) ids.add(id);
  }
  return ids;
}

/** The snapshot and projection directories this spawn hands to the backend. */
function directoriesInUse(details: ReadonlyMap<string, PortableRuntimeDetail>): Set<string> {
  const inUse = new Set<string>();
  for (const detail of details.values()) {
    if (detail.projectionDir) inUse.add(detail.projectionDir);
    for (const skill of detail.skills) inUse.add(path.dirname(skill.target));
  }
  return inUse;
}

export function resolvePluginRuntime(options: ResolvePluginRuntimeOptions): ResolvedPluginRuntime {
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  const pluginsDir = path.resolve(options.pluginsDir ?? PLUGINS_DIR);
  // Everything this writes (snapshots, projections, PLUGIN_DATA) sits under the data dir, which may
  // itself be reached through a symlink — a relocated CORTEX_HOME. Anchor on its real path so only
  // a symlink BELOW it is refused.
  const physicalDataDir = physicalUnder(dataDir, dataDir);
  const runtimeDir = physicalUnder(dataDir, options.runtimeDir ?? path.join(dataDir, 'data', 'plugin-runtime'));
  const selectedPluginDirs = (options.selectedPluginDirs ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (selectedPluginDirs.length === 0) return {};
  const builtinDir = options.builtinDir === undefined ? defaultBuiltinPluginsDir() : options.builtinDir;
  const ids = selectedCatalogIds(pluginsDir, dataDir, selectedPluginDirs, listBuiltinPluginIds(builtinDir));
  const entries = loadPluginCatalog({ pluginsDir, dataDir: physicalDataDir, builtinDir, ids });
  const classified = classifySelections(entries, catalogRoots(pluginsDir, entries), dataDir, selectedPluginDirs);
  if (classified.items.length === 0) return withWarnings({}, classified.warnings);
  const portable = collectPortableDetails(
    classified.portableSelections, options.backend, runtimeDir, portableMcpEnabled(options.mcpComposition),
  );
  warnLegacySkillCollisions(portable.skillClaims, classified.selectedLegacySkills);
  sweepStaleRuntimeDirs(path.join(runtimeDir, options.backend), directoriesInUse(portable.details));
  sweepStaleClaudeMcpFiles(runtimeDir);
  const resolved = resolvedRuntime(options.backend, classified.items, portable.details);
  return withWarnings(resolved, [...classified.warnings, ...portable.warnings]);
}

function withWarnings(resolved: ResolvedPluginRuntime, warnings: string[]): ResolvedPluginRuntime {
  return warnings.length > 0 ? { ...resolved, warnings } : resolved;
}
