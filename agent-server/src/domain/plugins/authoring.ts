//
// Every path here is re-resolved against its layer's plugins root with resolveContainedAbsolutePath,
// which walks each segment through realpath. A plugin directory is operator-writable, so a symlink
// planted inside one must not become a write outside the plugins root.
//
// Writes land only in the user's layer (PLUGINS_DIR). A built-in plugin is read from the install;
// editing one of its skills copies the skill into the user's layer first, where it replaces the
// built-in one whole.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteSync } from '@core/atomic-write.js';
import { PLUGINS_DIR } from '@core/paths.js';
import {
  AGENT_PLUGIN_V1_MCP_SCHEMA_URL,
  AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
  portableMcpSchema,
} from './agent-plugins-v1.js';
import { defaultBuiltinPluginsDir } from './builtin.js';
import {
  containsPath,
  isDirectoryPath,
  isRegularFile,
  pathExists,
  resolveContainedAbsolutePath,
} from './fs-helpers.js';
import { FRONTMATTER_RE, SKILL_NAME_RE } from './skill.js';

export type PluginWriteErrorCode = 'invalid-args' | 'not-found' | 'conflict';

export interface PluginWriteError extends Error {
  code: PluginWriteErrorCode;
}


function fail(code: PluginWriteErrorCode, message: string): PluginWriteError {
  return Object.assign(new Error(message), { code });
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertName(label: string, value: string): void {
  if (typeof value !== 'string' || value.length > 64 || !SKILL_NAME_RE.test(value)) {
    throw fail('invalid-args', `${label} '${String(value)}' must be lowercase letters, digits and single hyphens`);
  }
}

/** Resolve a path that must already exist inside a layer's plugins root. */
function contained(absolute: string, root: string = PLUGINS_DIR): string {
  const real = resolveContainedAbsolutePath(root, absolute);
  if (!real) throw fail('invalid-args', `path escapes the plugins directory: ${absolute}`);
  return real;
}

/** Resolve a path that may not exist yet. The deepest existing ancestor is realpath-checked, so a
 *  symlinked parent cannot redirect the write; the new leaf is then joined onto the real base. */
function containedTarget(absolute: string): string {
  const real = resolveContainedAbsolutePath(PLUGINS_DIR, absolute);
  if (real) return real;
  const parent = resolveContainedAbsolutePath(PLUGINS_DIR, path.dirname(absolute));
  if (!parent) throw fail('invalid-args', `path escapes the plugins directory: ${absolute}`);
  const target = path.join(parent, path.basename(absolute));
  if (!containsPath(PLUGINS_DIR, target)) {
    throw fail('invalid-args', `path escapes the plugins directory: ${absolute}`);
  }
  return target;
}

/** `relative` inside one layer of a plugin, or null when that layer does not have it. */
function inLayer(root: string | null, id: string, relative: string, isKind: (p: string) => boolean): string | null {
  const absolute = root ? path.join(root, id, relative) : null;
  if (!root || !absolute || !pathExists(absolute)) return null;
  const real = contained(absolute, root);
  return isKind(real) ? real : null;
}

function userLayer(id: string, relative = '.'): string | null {
  return inLayer(PLUGINS_DIR, id, relative, isDirectoryPath);
}

function builtinLayer(id: string, relative = '.'): string | null {
  return inLayer(defaultBuiltinPluginsDir(), id, relative, isDirectoryPath);
}

/** The user's own plugin directory; a built-in plugin's user layer counts once it exists. */
function pluginDirPath(id: string): string {
  assertName('plugin id', id);
  const dir = userLayer(id);
  if (!dir) throw fail('not-found', `Unknown plugin: '${id}'`);
  return dir;
}

/** Where a write to this plugin goes: its user layer, created for a built-in plugin without one. */
function writablePluginDir(id: string): string {
  assertName('plugin id', id);
  const own = userLayer(id);
  if (own) return own;
  if (!builtinLayer(id)) throw fail('not-found', `Unknown plugin: '${id}'`);
  const dir = containedTarget(path.join(PLUGINS_DIR, id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function skillDirPath(pluginId: string, skill: string): string {
  assertName('skill name', skill);
  const dir = contained(path.join(pluginDirPath(pluginId), 'skills', skill));
  if (!isDirectoryPath(dir)) throw fail('not-found', `Unknown skill: '${pluginId}/${skill}'`);
  return dir;
}

function skillFilePath(pluginId: string, skill: string): string {
  const file = contained(path.join(skillDirPath(pluginId, skill), 'SKILL.md'));
  if (!isRegularFile(file)) throw fail('not-found', `Missing SKILL.md: '${pluginId}/${skill}'`);
  return file;
}

interface EffectiveSkill {
  file: string;
  /** Read from the user's layer rather than the install. */
  user: boolean;
}

/** The SKILL.md in effect: the user's when their layer has one, otherwise the built-in. */
function effectiveSkillFile(pluginId: string, skill: string): EffectiveSkill {
  assertName('plugin id', pluginId);
  assertName('skill name', skill);
  const relative = path.join('skills', skill, 'SKILL.md');
  const own = inLayer(PLUGINS_DIR, pluginId, relative, isRegularFile);
  if (own) return { file: own, user: true };
  const shipped = inLayer(defaultBuiltinPluginsDir(), pluginId, relative, isRegularFile);
  if (shipped) return { file: shipped, user: false };
  if (!userLayer(pluginId) && !builtinLayer(pluginId)) throw fail('not-found', `Unknown plugin: '${pluginId}'`);
  throw fail('not-found', `Unknown skill: '${pluginId}/${skill}'`);
}

/** The user's SKILL.md for a skill. A built-in skill is copied into the user's layer whole first,
 *  since the user's copy replaces the built-in one whole. */
function userSkillFile(pluginId: string, skill: string, effective: EffectiveSkill): string {
  if (effective.user) return effective.file;
  const target = containedTarget(path.join(writablePluginDir(pluginId), 'skills', skill));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.dirname(effective.file), target, { recursive: true, force: false });
  return contained(path.join(target, 'SKILL.md'));
}

export interface SkillSource {
  /** The skill's address under the plugins root, for display. */
  path: string;
  content: string;
  baseHash: string;
}

export function readSkillSource(pluginId: string, skill: string): SkillSource {
  const { file } = effectiveSkillFile(pluginId, skill);
  const content = fs.readFileSync(file, 'utf8');
  return {
    path: path.posix.join('plugins', pluginId, 'skills', skill, 'SKILL.md'),
    content,
    baseHash: sha256(content),
  };
}

/** Optimistic concurrency, same contract as saveEntity: the caller passes the hash of the bytes it
 *  started from, and a mismatch means someone else — a hand edit, another tab — wrote in between.
 *  Silently overwriting that is how edits disappear without anyone noticing. */
export function writeSkillSource(
  pluginId: string,
  skill: string,
  content: string,
  baseHash: string,
): { baseHash: string } {
  const effective = effectiveSkillFile(pluginId, skill);
  if (sha256(fs.readFileSync(effective.file, 'utf8')) !== baseHash) {
    throw fail('conflict', `'${pluginId}/${skill}' changed on disk`);
  }
  atomicWriteSync(userSkillFile(pluginId, skill, effective), content);
  return { baseHash: sha256(content) };
}

/** Drop the user's copy of a built-in skill, so the built-in one is in effect again. */
export function revertSkill(pluginId: string, skill: string): void {
  assertName('skill name', skill);
  if (!builtinLayer(pluginId, path.join('skills', skill))) {
    throw fail('invalid-args', `'${pluginId}/${skill}' is not a built-in skill`);
  }
  const own = userLayer(pluginId, path.join('skills', skill));
  if (!own) return;
  fs.rmSync(own, { recursive: true, force: true });
  removeIfEmpty(path.dirname(own));
  removeIfEmpty(path.dirname(path.dirname(own)));
}

function removeIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Not empty or already gone: either way there is nothing to tidy.
  }
}

function skillTemplate(skill: string, description: string): string {
  return [
    '---',
    `name: ${skill}`,
    `description: ${description}`,
    '---',
    '',
    `# ${skill}`,
    '',
  ].join('\n');
}

/** A new skill must not take a built-in skill's name: in the user's layer it would replace it. */
function freeSkillTarget(pluginId: string, skill: string): string {
  assertName('skill name', skill);
  const exists = fail('invalid-args', `Skill '${pluginId}/${skill}' already exists`);
  if (builtinLayer(pluginId, path.join('skills', skill))) throw exists;
  const skillsRoot = containedTarget(path.join(writablePluginDir(pluginId), 'skills'));
  const dir = containedTarget(path.join(skillsRoot, skill));
  if (pathExists(dir)) throw exists;
  return dir;
}

export function createSkill(pluginId: string, skill: string, description: string): void {
  assertName('skill name', skill);
  if (description.trim().length === 0) throw fail('invalid-args', 'description must not be empty');
  const dir = freeSkillTarget(pluginId, skill);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(path.join(dir, 'SKILL.md'), skillTemplate(skill, description.trim()));
}

/** Rewrite the frontmatter `name` so it keeps agreeing with the directory, which is the one
 *  disagreement the loader still treats as fatal. Only the leading frontmatter block is touched — a
 *  `name:` line in the body is prose — and a block without a top-level `name` gets one. A file with
 *  no frontmatter at all is left alone: the loader rejects it either way. */
function renameInFrontmatter(content: string, skill: string): string {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return content;
  const yaml = match[1];
  const eol = match[0].startsWith('---\r\n') ? '\r\n' : '\n';
  const nameLine = /^name:[^\r\n]*/m;
  const renamed = nameLine.test(yaml) ? yaml.replace(nameLine, `name: ${skill}`) : `name: ${skill}${eol}${yaml}`;
  const start = 3 + eol.length;
  return content.slice(0, start) + renamed + content.slice(start + yaml.length);
}

/** Move the directory first and only then rewrite its name, putting the directory back if the
 *  rewrite fails: either step failing leaves one valid skill, never a renamed file in the old place. */
export function moveSkill(
  from: { pluginId: string; skill: string },
  to: { pluginId: string; skill: string },
): void {
  assertName('skill name', to.skill);
  const source = skillDirPath(from.pluginId, from.skill);
  skillFilePath(from.pluginId, from.skill); // a directory without SKILL.md is not a skill to move
  if (from.pluginId === to.pluginId && from.skill === to.skill) {
    throw fail('invalid-args', 'source and destination are the same skill');
  }
  const target = freeSkillTarget(to.pluginId, to.skill);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  if (from.skill === to.skill) return;
  try {
    const file = contained(path.join(target, 'SKILL.md'));
    atomicWriteSync(file, renameInFrontmatter(fs.readFileSync(file, 'utf8'), to.skill));
  } catch (error) {
    fs.renameSync(target, source);
    throw error;
  }
}

export function removeSkill(pluginId: string, skill: string): void {
  fs.rmSync(skillDirPath(pluginId, skill), { recursive: true, force: true });
}

function portableManifestText(id: string, description: string): string {
  const body: Record<string, string> = {
    $schema: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
    name: id,
    version: '0.1.0',
  };
  if (description.trim().length > 0) body.description = description.trim();
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function createPlugin(id: string, description: string): void {
  assertName('plugin id', id);
  const dir = containedTarget(path.join(PLUGINS_DIR, id));
  if (pathExists(dir) || builtinLayer(id)) throw fail('invalid-args', `Plugin '${id}' already exists`);
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  atomicWriteSync(path.join(dir, 'plugin.json'), portableManifestText(id, description));
}

export function removePlugin(id: string): void {
  fs.rmSync(pluginDirPath(id), { recursive: true, force: true });
}

/** Give a legacy plugin the root manifest that portable discovery needs, reusing the legacy
 *  manifest's own fields. The legacy file is left in place. */
export function convertToPortable(id: string): void {
  const dir = pluginDirPath(id);
  const root = path.join(dir, 'plugin.json');
  if (pathExists(root)) throw fail('invalid-args', `Plugin '${id}' already has a root plugin.json`);
  const legacyPath = path.join(dir, '.claude-plugin', 'plugin.json');
  const legacy = pathExists(legacyPath) ? readJson(contained(legacyPath)) : null;
  const body: Record<string, unknown> = {
    $schema: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
    name: id,
    version: typeof legacy?.version === 'string' ? legacy.version : '0.1.0',
  };
  if (typeof legacy?.description === 'string') body.description = legacy.description;
  atomicWriteSync(containedTarget(root), `${JSON.stringify(body, null, 2)}\n`);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return parseJsonObject(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** The mcp.json in effect: the user's when their layer has one, otherwise the built-in plugin's. */
function effectiveMcpFile(pluginId: string): string | null {
  assertName('plugin id', pluginId);
  const own = inLayer(PLUGINS_DIR, pluginId, 'mcp.json', isRegularFile);
  if (own) return own;
  if (!userLayer(pluginId) && !builtinLayer(pluginId)) throw fail('not-found', `Unknown plugin: '${pluginId}'`);
  return inLayer(defaultBuiltinPluginsDir(), pluginId, 'mcp.json', isRegularFile);
}

export interface McpSource {
  servers: Record<string, unknown>;
  /** Hash of the mcp.json bytes in effect; an absent file hashes as empty. */
  baseHash: string;
}

/** The raw envelope, secrets included. Only the ui-service redaction layer may see this — it must
 *  never be returned to a browser unfiltered (that is the whole point of PLUGIN_MCP_RUNTIME). */
export function readMcpSource(pluginId: string): McpSource {
  const file = effectiveMcpFile(pluginId);
  if (!file) return { servers: {}, baseHash: sha256('') };
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseJsonObject(text);
  if (!parsed) throw fail('invalid-args', `'${pluginId}/mcp.json' is not valid JSON`);
  const servers = parsed.mcpServers;
  const valid = servers && typeof servers === 'object' && !Array.isArray(servers);
  return { servers: valid ? servers as Record<string, unknown> : {}, baseHash: sha256(text) };
}

export function readMcpEnvelope(pluginId: string): Record<string, unknown> {
  return readMcpSource(pluginId).servers;
}

/** Optimistic concurrency, same contract as writeSkillSource. */
export function writeMcpEnvelope(pluginId: string, servers: Record<string, unknown>, baseHash: string): void {
  if (readMcpSource(pluginId).baseHash !== baseHash) {
    throw fail('conflict', `'${pluginId}/mcp.json' changed on disk`);
  }
  const envelope = { $schema: AGENT_PLUGIN_V1_MCP_SCHEMA_URL, mcpServers: servers };
  const parsed = portableMcpSchema.safeParse(envelope);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw fail('invalid-args', `mcp.json would be invalid: ${detail}`);
  }
  const file = containedTarget(path.join(writablePluginDir(pluginId), 'mcp.json'));
  atomicWriteSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
}
