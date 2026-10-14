import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from '@core/paths.js';
import { PORTABLE_MANIFEST_FIELDS, portableManifestSchema } from './agent-plugins-v1.js';
import {
  isDirectoryPath,
  isPlainObject,
  isRegularFile,
  listImmediateChildNames,
  pathExists,
  realPath,
  resolveContainedAbsolutePath,
} from './fs-helpers.js';
import { loadPortableMcpCatalog } from './mcp.js';
import { loadSkillFile, readSkillDescription } from './skill.js';
import { buildProjectedSkillTree } from './skill-projection.js';
import { defaultBuiltinPluginsDir } from './builtin.js';
import {
  formatPath,
  makeIssue,
  placeSkill,
  portableNamespace,
  skillRoot as layerRootOf,
  type PluginCatalogEntry,
  type PluginCatalogIssue,
  type PluginCatalogManifest,
  type PluginCatalogSkill,
  type PluginSkillFile,
} from './catalog-types.js';

interface PortableManifestResult {
  manifest: PluginCatalogManifest;
  valid: boolean;
  issues: PluginCatalogIssue[];
}

interface ManifestPathResult {
  state: 'missing' | 'present' | 'invalid';
  path?: string;
  issues: PluginCatalogIssue[];
}

type SkillFormat = 'portable' | 'legacy';

function publicRootDir(id: string): string {
  return path.join('plugins', id);
}

function emptyEntry(id: string): PluginCatalogEntry {
  return {
    id,
    origin: 'local',
    kind: 'unknown',
    rootDir: publicRootDir(id),
    valid: false,
    manifest: { source: 'none' },
    skills: [],
    mcp: { status: 'missing', servers: [] },
    issues: [],
  };
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function zodIssues(
  error: { issues: Array<{ path: Array<PropertyKey>; message: string }> },
): PluginCatalogIssue[] {
  return error.issues.map((issue) => makeIssue(
    'manifest_invalid',
    'manifest',
    formatPath(issue.path) || 'plugin.json',
    issue.message,
  ));
}

function sanitizePortableManifest(
  body: Record<string, unknown>,
): { sanitized: Record<string, unknown>; issues: PluginCatalogIssue[] } {
  const sanitized: Record<string, unknown> = {};
  const issues: PluginCatalogIssue[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!PORTABLE_MANIFEST_FIELDS.has(key)) {
      issues.push(makeIssue('manifest_unknown_field', 'manifest', `plugin.json.${key}`, `Ignoring unknown field "${key}"`));
      continue;
    }
    if (key === 'extensions' && !isPlainObject(value)) {
      issues.push(makeIssue('manifest_extensions_ignored', 'manifest', 'plugin.json.extensions', 'Ignoring non-object extensions field'));
      continue;
    }
    sanitized[key] = value;
  }
  return { sanitized, issues };
}

function parsePortableManifest(text: string): PortableManifestResult {
  try {
    const raw = JSON.parse(text);
    if (!isPlainObject(raw)) {
      return invalidRootManifest('plugin.json must contain a top-level object');
    }
    const sanitized = sanitizePortableManifest(raw);
    const parsed = portableManifestSchema.safeParse(sanitized.sanitized);
    if (!parsed.success) {
      return { manifest: { source: 'root' }, valid: false, issues: [...sanitized.issues, ...zodIssues(parsed.error)] };
    }
    return {
      manifest: portableManifest(parsed.data),
      valid: true,
      issues: sanitized.issues,
    };
  } catch {
    return invalidRootManifest('plugin.json is not valid JSON');
  }
}

function portableManifest(
  manifest: { $schema: string; name: string; version?: string; description?: string },
): PluginCatalogManifest {
  return {
    source: 'root',
    name: manifest.name,
    schema: manifest.$schema,
    version: trimText(manifest.version),
    description: trimText(manifest.description),
  };
}

function invalidRootManifest(message: string): PortableManifestResult {
  return {
    manifest: { source: 'root' },
    valid: false,
    issues: [makeIssue('manifest_invalid', 'manifest', 'plugin.json', message)],
  };
}

function parseLegacyManifest(text: string): PortableManifestResult {
  try {
    const raw = JSON.parse(text);
    if (!isPlainObject(raw) || typeof raw.name !== 'string' || raw.name.trim() === '') {
      return invalidLegacyManifest('legacy manifest must define a non-empty name');
    }
    return {
      manifest: {
        source: 'legacy',
        name: raw.name.trim(),
        version: trimText(raw.version),
        description: trimText(raw.description),
      },
      valid: true,
      issues: [],
    };
  } catch {
    return invalidLegacyManifest('legacy manifest is not valid JSON');
  }
}

function invalidLegacyManifest(message: string): PortableManifestResult {
  return {
    manifest: { source: 'legacy' },
    valid: false,
    issues: [makeIssue('legacy_manifest_invalid', 'manifest', '.claude-plugin/plugin.json', message)],
  };
}

function invalidFileIssue(relativePath: string): PluginCatalogIssue {
  return makeIssue(
    'manifest_invalid',
    'manifest',
    relativePath,
    `${relativePath} must be a regular file inside the plugin root`,
  );
}

function manifestPath(pluginRoot: string, relativePath: string): ManifestPathResult {
  const absolute = path.join(pluginRoot, relativePath);
  if (!pathExists(absolute)) return { state: 'missing', issues: [] };
  const contained = resolveContainedAbsolutePath(pluginRoot, absolute);
  if (!contained || !isRegularFile(contained)) {
    return { state: 'invalid', issues: [invalidFileIssue(relativePath)] };
  }
  return { state: 'present', path: contained, issues: [] };
}

function skillRootIssue(message: string): PluginCatalogIssue {
  return makeIssue('skill_invalid', 'skill', 'skills', message);
}

function skillRoot(pluginRoot: string): ManifestPathResult {
  const absolute = path.join(pluginRoot, 'skills');
  if (!pathExists(absolute)) return { state: 'missing', issues: [] };
  const contained = resolveContainedAbsolutePath(pluginRoot, absolute);
  if (!contained) {
    return { state: 'invalid', issues: [skillRootIssue('skills must resolve to a directory inside the plugin root')] };
  }
  if (!isDirectoryPath(contained)) {
    return { state: 'invalid', issues: [skillRootIssue('skills must be a directory inside the plugin root')] };
  }
  return { state: 'present', path: contained, issues: [] };
}

function skillChildNames(root: string): { names: string[]; issues: PluginCatalogIssue[] } {
  try {
    return { names: listImmediateChildNames(root), issues: [] };
  } catch {
    return { names: [], issues: [skillRootIssue('skills could not be read')] };
  }
}

function discoverSkills(
  pluginRoot: string,
  format: SkillFormat,
): { skills: PluginCatalogSkill[]; issues: PluginCatalogIssue[] } {
  const root = skillRoot(pluginRoot);
  if (root.state !== 'present' || !root.path) {
    return { skills: [], issues: root.issues };
  }
  const listed = skillChildNames(root.path);
  const skills: PluginCatalogSkill[] = [];
  const issues = [...listed.issues];
  for (const name of listed.names) {
    const result = loadContainedSkill(pluginRoot, root.path, name, format);
    if (result.skill) skills.push(placeSkill(result.skill, pluginRoot, 'local'));
    issues.push(...result.issues);
  }
  return { skills, issues };
}

function loadPortableContainedSkill(
  pluginRoot: string,
  name: string,
  skillFile: string,
): { skill?: PluginSkillFile; issues: PluginCatalogIssue[] } {
  const loaded = loadSkillFile(name, skillFile);
  if (!loaded.skill) return loaded;
  try {
    buildProjectedSkillTree(pluginRoot, path.dirname(skillFile));
    return loaded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { issues: [...loaded.issues, makeIssue(
      'skill_invalid', 'skill', `skills.${name}`, `Skill support tree is invalid: ${message}`,
    )] };
  }
}

function loadContainedSkill(
  pluginRoot: string,
  skillsRoot: string,
  name: string,
  format: SkillFormat,
): { skill?: PluginSkillFile; issues: PluginCatalogIssue[] } {
  const skillFile = path.join(skillsRoot, name, 'SKILL.md');
  const contained = resolveContainedAbsolutePath(pluginRoot, skillFile);
  if (!contained || !isRegularFile(contained)) {
    return { issues: [makeIssue(
      'skill_outside_plugin_root', 'skill', `skills.${name}.SKILL.md`,
      'SKILL.md must remain inside the plugin root',
    )] };
  }
  if (format === 'legacy') {
    return {
      skill: { name, dir: path.join('skills', name), description: readSkillDescription(contained) },
      issues: [],
    };
  }
  return loadPortableContainedSkill(pluginRoot, name, contained);
}

function portableEntry(
  id: string,
  pluginRoot: string,
  dataDir: string,
  manifestPathText: string,
): PluginCatalogEntry {
  const entry = emptyEntry(id);
  const manifest = parsePortableManifest(manifestPathText);
  entry.kind = 'portable';
  entry.manifest = manifest.manifest;
  entry.issues.push(...manifest.issues);
  if (!manifest.valid || !manifest.manifest.schema) return entry;
  const skills = discoverSkills(pluginRoot, 'portable');
  const mcp = loadPortableMcpCatalog(id, pluginRoot, dataDir, manifest.manifest.schema);
  entry.valid = true;
  entry.skills = skills.skills;
  entry.mcp = { status: mcp.status, servers: mcp.servers };
  entry.issues.push(...skills.issues, ...mcp.issues);
  return entry;
}

function legacyEntry(
  id: string,
  pluginRoot: string,
  manifestText: string,
): PluginCatalogEntry {
  const entry = emptyEntry(id);
  const manifest = parseLegacyManifest(manifestText);
  entry.kind = 'legacy';
  entry.manifest = manifest.manifest;
  entry.issues.push(...manifest.issues);
  if (!manifest.valid) return entry;
  const skills = discoverSkills(pluginRoot, 'legacy');
  entry.valid = true;
  entry.skills = skills.skills;
  entry.issues.push(...skills.issues);
  return entry;
}

function unknownEntry(id: string): PluginCatalogEntry {
  const entry = emptyEntry(id);
  entry.issues.push(makeIssue('manifest_missing', 'manifest', null, 'plugin.json and .claude-plugin/plugin.json are both missing'));
  return entry;
}

function readTextFile(
  filePath: string,
  code: 'manifest_invalid' | 'legacy_manifest_invalid',
  relativePath: string,
): { text?: string; issues: PluginCatalogIssue[] } {
  try {
    return { text: fs.readFileSync(filePath, 'utf8'), issues: [] };
  } catch {
    return { issues: [makeIssue(code, 'manifest', relativePath, `${relativePath} could not be read`)] };
  }
}

function validPluginRoot(pluginsRoot: string, pluginPath: string): string | null {
  const contained = resolveContainedAbsolutePath(pluginsRoot, pluginPath);
  return contained && isDirectoryPath(contained) ? contained : null;
}

function pluginRootError(
  id: string,
  requestedRoot: string,
): PluginCatalogEntry {
  const entry = emptyEntry(id);
  const exists = pathExists(requestedRoot);
  const code = exists ? 'plugin_root_outside_plugins_dir' : 'plugin_root_not_directory';
  const message = code === 'plugin_root_outside_plugins_dir'
    ? 'plugin root must resolve inside PLUGINS_DIR'
    : 'plugin root must be a directory';
  entry.issues.push(makeIssue(code, 'plugin', id, message));
  return entry;
}

function entryFromPortablePath(
  id: string,
  pluginRoot: string,
  dataDir: string,
  filePath: string,
): PluginCatalogEntry {
  const text = readTextFile(filePath, 'manifest_invalid', 'plugin.json');
  if (text.text !== undefined) return portableEntry(id, pluginRoot, dataDir, text.text);
  const entry = emptyEntry(id);
  entry.kind = 'portable';
  entry.manifest = { source: 'root' };
  entry.issues.push(...text.issues);
  return entry;
}

function entryFromLegacyPath(
  id: string,
  pluginRoot: string,
  filePath: string,
): PluginCatalogEntry {
  const text = readTextFile(filePath, 'legacy_manifest_invalid', '.claude-plugin/plugin.json');
  if (text.text !== undefined) return legacyEntry(id, pluginRoot, text.text);
  const entry = emptyEntry(id);
  entry.kind = 'legacy';
  entry.manifest = { source: 'legacy' };
  entry.issues.push(...text.issues);
  return entry;
}

function portablePathResult(
  id: string,
  pluginRoot: string,
  dataDir: string,
): PluginCatalogEntry | null {
  const rootManifest = manifestPath(pluginRoot, 'plugin.json');
  if (rootManifest.state === 'invalid') {
    const entry = emptyEntry(id);
    entry.kind = 'portable';
    entry.manifest = { source: 'root' };
    entry.issues.push(...rootManifest.issues);
    return entry;
  }
  if (rootManifest.state !== 'present' || !rootManifest.path) return null;
  return entryFromPortablePath(id, pluginRoot, dataDir, rootManifest.path);
}

function legacyPathResult(
  id: string,
  pluginRoot: string,
): PluginCatalogEntry | null {
  const legacyManifest = manifestPath(pluginRoot, path.join('.claude-plugin', 'plugin.json'));
  if (legacyManifest.state === 'invalid') {
    const entry = emptyEntry(id);
    entry.kind = 'legacy';
    entry.manifest = { source: 'legacy' };
    entry.issues.push(...legacyManifest.issues);
    return entry;
  }
  if (legacyManifest.state !== 'present' || !legacyManifest.path) return null;
  return entryFromLegacyPath(id, pluginRoot, legacyManifest.path);
}

function loadPluginEntry(
  id: string,
  pluginsRoot: string,
  dataDir: string,
): PluginCatalogEntry {
  const requestedRoot = path.join(pluginsRoot, id);
  const pluginRoot = validPluginRoot(pluginsRoot, requestedRoot);
  if (!pluginRoot) return pluginRootError(id, requestedRoot);
  return portablePathResult(id, pluginRoot, dataDir)
    ?? legacyPathResult(id, pluginRoot)
    ?? unknownEntry(id);
}

function safePluginEntry(
  id: string,
  pluginsRoot: string,
  dataDir: string,
): PluginCatalogEntry {
  try {
    return loadPluginEntry(id, pluginsRoot, dataDir);
  } catch {
    const entry = emptyEntry(id);
    entry.issues.push(makeIssue('manifest_invalid', 'manifest', 'plugin.json', 'plugin entry could not be loaded'));
    return entry;
  }
}

interface CatalogLayers {
  /** Real path of the user's plugins dir; null when there is none. */
  user: string | null;
  /** Real path of the built-in plugins dir; null when built-ins are left out. */
  builtin: string | null;
  dataDir: string;
}

function physicalDir(dir: string | null): string | null {
  return dir && isDirectoryPath(dir) ? realPath(dir) : null;
}

function catalogIds(layers: CatalogLayers): string[] {
  const builtin = layers.builtin ? listImmediateChildNames(layers.builtin) : [];
  const user = layers.user ? listImmediateChildNames(layers.user) : [];
  return [...new Set([...builtin, ...user])].sort();
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** The user's skills replace the built-in ones of the same name whole, and the rest add. */
function overlaySkills(entry: PluginCatalogEntry, user: { skills: PluginCatalogSkill[]; issues: PluginCatalogIssue[] }): void {
  const skills = new Map(entry.skills.map((skill) => [skill.name, skill]));
  for (const skill of user.skills) {
    skills.set(skill.name, placeSkill(skill, layerRootOf(skill)!, skills.has(skill.name) ? 'overridden' : 'local'));
  }
  entry.skills = [...skills.values()].sort(byName);
  entry.issues.push(...user.issues);
}

/** A user `mcp.json` replaces the built-in plugin's whole, servers and issues alike. */
function overlayMcp(entry: PluginCatalogEntry, userRoot: string, dataDir: string): void {
  if (!pathExists(path.join(userRoot, 'mcp.json')) || !entry.manifest.schema) return;
  const mcp = loadPortableMcpCatalog(entry.id, userRoot, dataDir, entry.manifest.schema);
  entry.mcp = { status: mcp.status, servers: mcp.servers };
  entry.issues = [...entry.issues.filter((issue) => issue.scope !== 'mcp' && issue.scope !== 'server'), ...mcp.issues];
}

function withUserLayer(entry: PluginCatalogEntry, userPlugins: string | null, dataDir: string): PluginCatalogEntry {
  const requested = userPlugins ? path.join(userPlugins, entry.id) : null;
  if (!requested || !pathExists(requested)) return entry;
  const userRoot = validPluginRoot(userPlugins!, requested);
  if (!userRoot) return { ...entry, issues: [...entry.issues, ...pluginRootError(entry.id, requested).issues] };
  if (entry.kind === 'portable' && entry.valid) {
    overlaySkills(entry, discoverSkills(userRoot, 'portable'));
    overlayMcp(entry, userRoot, dataDir);
  }
  return entry;
}

function builtinEntry(id: string, layers: CatalogLayers): PluginCatalogEntry {
  const shipped = safePluginEntry(id, layers.builtin!, layers.dataDir);
  const entry: PluginCatalogEntry = {
    ...shipped,
    origin: 'builtin',
    skills: shipped.skills.map((skill) => placeSkill(skill, layerRootOf(skill)!, 'builtin')),
  };
  return withUserLayer(entry, layers.user, layers.dataDir);
}

function layeredEntry(id: string, layers: CatalogLayers): PluginCatalogEntry {
  if (layers.builtin && pathExists(path.join(layers.builtin, id))) return builtinEntry(id, layers);
  return safePluginEntry(id, layers.user!, layers.dataDir);
}

export interface PluginCatalogOptions {
  pluginsDir?: string;
  dataDir?: string;
  /** The built-in plugins laid under the user's; null leaves them out. Defaults to the install's,
   *  except in a sealed home. */
  builtinDir?: string | null;
  /** Limits the load to those plugin ids: a spawn needs only the plugins it selected, and
   *  validating every other plugin's skill trees on each spawn is wasted work. */
  ids?: ReadonlySet<string>;
}

/** Every plugin, built-in and the user's: a user `plugins/<id>` with a built-in id is that plugin's
 *  user layer, and any other is a plugin of its own. */
export function loadPluginCatalog(options: PluginCatalogOptions = {}): PluginCatalogEntry[] {
  const layers: CatalogLayers = {
    user: physicalDir(path.resolve(options.pluginsDir ?? PLUGINS_DIR)),
    builtin: physicalDir(options.builtinDir === undefined ? defaultBuiltinPluginsDir() : options.builtinDir),
    dataDir: path.resolve(options.dataDir ?? DATA_DIR),
  };
  const entries = catalogIds(layers)
    .filter((id) => !options.ids || options.ids.has(id))
    .map((id) => layeredEntry(id, layers));
  flagSharedNamespaces(entries);
  return entries;
}

/** A session that selects two portable plugins under one name loads only the first (runtime.ts
 *  `claimNamespace`). Say so on each of them, where the operator looks at plugin problems. */
function flagSharedNamespaces(entries: PluginCatalogEntry[]): void {
  const holders = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind !== 'portable' || !entry.valid) continue;
    const namespace = portableNamespace(entry);
    holders.set(namespace, [...(holders.get(namespace) ?? []), entry.id]);
  }
  for (const entry of entries) {
    if (entry.kind !== 'portable' || !entry.valid) continue;
    const others = (holders.get(portableNamespace(entry)) ?? []).filter((id) => id !== entry.id);
    if (others.length === 0) continue;
    entry.issues.push(makeIssue('manifest_name_duplicate', 'manifest', 'plugin.json.name',
      `Plugin name "${portableNamespace(entry)}" is also used by ${others.map((id) => `'${id}'`).join(', ')}; `
      + 'a session that selects more than one of them loads only the first selected.'));
  }
}

export interface PluginSkillGroup {
  plugin: string;
  skills: string[];
}

/** One skill a session loads, with what a slash palette needs to offer it. */
export interface SelectedSkill {
  plugin: string;
  /** The plugin's name in a Claude projection, invoked there as `/<namespace>:<name>`. */
  namespace: string;
  name: string;
  description: string;
}

function sortedNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** A selected directory the runtime hands to the backend as it is — a legacy package, a directory
 *  without a manifest, or one outside the plugins root. Both backends read the plugin layout's
 *  `skills/<name>/SKILL.md` from it, so that is what is listed. */
function passThroughSkills(directory: string): Array<{ name: string; description: string }> {
  const root = path.join(directory, 'skills');
  return listImmediateChildNames(root)
    .filter((name) => isRegularFile(path.join(root, name, 'SKILL.md')))
    .map((name) => ({ name, description: readSkillDescription(path.join(root, name, 'SKILL.md')) }));
}

function sortedSkills<T extends { name: string }>(skills: readonly T[]): T[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

/** Catalog entries by the paths that select them: the `plugins/<id>` address, and its real path. */
function entriesByAddress(entries: readonly PluginCatalogEntry[], pluginsDir: string): Map<string, PluginCatalogEntry> {
  const byAddress = new Map<string, PluginCatalogEntry>();
  for (const entry of entries) {
    const address = path.join(pluginsDir, entry.id);
    byAddress.set(address, entry);
    const real = realPath(address);
    if (real) byAddress.set(real, entry);
  }
  return byAddress;
}

function skillGroup(value: string, directory: string, entry: PluginCatalogEntry | undefined): SelectedSkill[] {
  if (entry?.kind === 'portable' && !entry.valid) return [];
  const plugin = entry?.id ?? value;
  const namespace = entry ? portableNamespace(entry) : path.basename(directory);
  const skills = entry?.kind === 'portable' ? entry.skills : passThroughSkills(directory);
  return sortedSkills(skills).map((skill) => ({
    plugin, namespace, name: skill.name, description: skill.description,
  }));
}

/** The skills a session selecting `pluginDirs` loads, grouped by plugin in selection order, following
 *  the runtime's classification (runtime.ts `classifySelections`): a valid portable plugin
 *  contributes its catalog skills, an invalid one is skipped, and every other directory is passed
 *  through. */
function selectedSkillGroups(
  entries: readonly PluginCatalogEntry[],
  pluginsDir: string,
  dataDir: string,
  pluginDirs: readonly string[],
): SelectedSkill[][] {
  const byAddress = entriesByAddress(entries, pluginsDir);
  const groups: SelectedSkill[][] = [];
  const seen = new Set<string>();
  for (const value of pluginDirs) {
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(dataDir, value);
    const directory = realPath(absolute) ?? absolute;
    if (seen.has(directory)) continue;
    seen.add(directory);
    groups.push(skillGroup(value, directory, byAddress.get(absolute) ?? byAddress.get(directory)));
  }
  return groups.filter((group) => group.length > 0);
}

interface SkillListOptions {
  pluginsDir?: string;
  dataDir?: string;
  builtinDir?: string | null;
}

function catalogFor(options: SkillListOptions): { entries: PluginCatalogEntry[]; pluginsDir: string; dataDir: string } {
  const pluginsDir = path.resolve(options.pluginsDir ?? PLUGINS_DIR);
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  return { entries: loadPluginCatalog({ pluginsDir, dataDir, builtinDir: options.builtinDir }), pluginsDir, dataDir };
}

/** Every skill a session selecting `pluginDirs` loads, in the order {@link listSkillGroups} lists them. */
export function listSelectedSkills(
  options: SkillListOptions & { pluginDirs: readonly string[] },
): SelectedSkill[] {
  const { entries, pluginsDir, dataDir } = catalogFor(options);
  return selectedSkillGroups(entries, pluginsDir, dataDir, options.pluginDirs).flat();
}

export function listSkillGroups(
  options: SkillListOptions & { pluginDirs?: readonly string[] } = {},
): PluginSkillGroup[] {
  const { entries, pluginsDir, dataDir } = catalogFor(options);
  if (options.pluginDirs) {
    return selectedSkillGroups(entries, pluginsDir, dataDir, options.pluginDirs)
      .map((group) => ({ plugin: group[0].plugin, skills: group.map((skill) => skill.name) }));
  }
  return entries
    .filter((entry) => entry.valid && entry.skills.length > 0)
    .map((entry) => ({ plugin: entry.id, skills: sortedNames(entry.skills.map((skill) => skill.name)) }));
}
