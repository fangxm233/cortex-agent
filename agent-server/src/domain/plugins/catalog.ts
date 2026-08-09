// input:  plugin roots, schemas, skill and MCP loaders
// output: plugin catalog entries plus format-aware local issues
// pos:    Read-only inventory of installed plugins
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from '@core/paths.js';
import {
  AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
  PORTABLE_MANIFEST_FIELDS,
  portableManifestSchema,
} from './agent-plugins-v1.js';
import {
  isDirectoryPath,
  isPlainObject,
  isRegularFile,
  listImmediateChildNames,
  lstatExists,
  resolveContainedAbsolutePath,
} from './fs-helpers.js';
import { loadPortableMcpCatalog } from './mcp.js';
import { loadSkillFile } from './skill.js';
import { buildProjectedSkillTree } from './skill-projection.js';
import type {
  PluginCatalogEntry,
  PluginCatalogIssue,
  PluginCatalogManifest,
  PluginCatalogSkill,
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

interface SkillRootResult {
  state: 'missing' | 'present' | 'invalid';
  path?: string;
  issues: PluginCatalogIssue[];
}

type SkillFormat = 'portable' | 'legacy';

function makeIssue(
  code: PluginCatalogIssue['code'],
  scope: PluginCatalogIssue['scope'],
  filePath: string | null,
  message: string,
): PluginCatalogIssue {
  return { code, scope, path: filePath, message };
}

function publicRootDir(id: string): string {
  return path.join('plugins', id);
}

function emptyEntry(id: string): PluginCatalogEntry {
  return {
    id,
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

function formatPath(parts: ReadonlyArray<PropertyKey>): string {
  return parts.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    return text ? `${text}.${String(part)}` : String(part);
  }, '');
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

function invalidFileIssue(
  relativePath: string,
  scope: 'manifest' | 'mcp',
): PluginCatalogIssue {
  const code = scope === 'manifest' ? 'manifest_invalid' : 'mcp_invalid';
  const message = scope === 'manifest'
    ? `${relativePath} must be a regular file inside the plugin root`
    : 'mcp.json must be a regular file inside the plugin root';
  return makeIssue(code, scope, relativePath, message);
}

function manifestPath(
  pluginRoot: string,
  relativePath: string,
  scope: 'manifest' | 'mcp',
): ManifestPathResult {
  const absolute = path.join(pluginRoot, relativePath);
  if (!lstatExists(absolute)) return { state: 'missing', issues: [] };
  const contained = resolveContainedAbsolutePath(pluginRoot, absolute);
  if (!contained || !isRegularFile(contained)) {
    return { state: 'invalid', issues: [invalidFileIssue(relativePath, scope)] };
  }
  return { state: 'present', path: contained, issues: [] };
}

function skillRootIssue(message: string): PluginCatalogIssue {
  return makeIssue('skill_invalid', 'skill', 'skills', message);
}

function skillRoot(pluginRoot: string): SkillRootResult {
  const absolute = path.join(pluginRoot, 'skills');
  if (!lstatExists(absolute)) return { state: 'missing', issues: [] };
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
    if (result.skill) skills.push(result.skill);
    issues.push(...result.issues);
  }
  return { skills, issues };
}

function loadPortableContainedSkill(
  pluginRoot: string,
  name: string,
  skillFile: string,
): { skill?: PluginCatalogSkill; issues: PluginCatalogIssue[] } {
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
): { skill?: PluginCatalogSkill; issues: PluginCatalogIssue[] } {
  const skillFile = path.join(skillsRoot, name, 'SKILL.md');
  const contained = resolveContainedAbsolutePath(pluginRoot, skillFile);
  if (!contained || !isRegularFile(contained)) {
    return { issues: [makeIssue(
      'skill_outside_plugin_root', 'skill', `skills.${name}.SKILL.md`,
      'SKILL.md must remain inside the plugin root',
    )] };
  }
  if (format === 'legacy') return { skill: { name, dir: path.join('skills', name) }, issues: [] };
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
  const exists = lstatExists(requestedRoot);
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
  const rootManifest = manifestPath(pluginRoot, 'plugin.json', 'manifest');
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
  const legacyManifest = manifestPath(pluginRoot, path.join('.claude-plugin', 'plugin.json'), 'manifest');
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

export function loadPluginCatalog(
  options: { pluginsDir?: string; dataDir?: string } = {},
): PluginCatalogEntry[] {
  const pluginsDir = path.resolve(options.pluginsDir ?? PLUGINS_DIR);
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  if (!lstatExists(pluginsDir)) return [];
  const pluginsRoot = fs.realpathSync(pluginsDir);
  return listImmediateChildNames(pluginsRoot)
    .map((id) => safePluginEntry(id, pluginsRoot, dataDir));
}

export const AGENT_PLUGIN_V1_DRAFT_SCHEMA = AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL;
