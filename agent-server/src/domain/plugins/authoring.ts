// input:  plugin ids, skill names, SKILL.md text, portable MCP envelopes
// output: contained create/write/move/remove operations under PLUGINS_DIR
// pos:    Write side of the plugin catalog — the read side (catalog.ts) never mutates
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Every path here is re-resolved against PLUGINS_DIR with resolveContainedAbsolutePath, which
// walks each segment through realpath. A plugin directory is operator-writable, so a symlink
// planted inside one must not become a write outside the plugins root.

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
import {
  containsPath,
  isDirectoryPath,
  isRegularFile,
  lstatExists,
  resolveContainedAbsolutePath,
} from './fs-helpers.js';

export type PluginWriteErrorCode = 'invalid-args' | 'not-found' | 'conflict';

export interface PluginWriteError extends Error {
  code: PluginWriteErrorCode;
}

/** Agent Skills canonical name, also used for plugin ids: lowercase, digits, single hyphens. */
const NAME_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function fail(code: PluginWriteErrorCode, message: string): PluginWriteError {
  return Object.assign(new Error(message), { code });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertName(label: string, value: string): void {
  if (typeof value !== 'string' || value.length > 64 || !NAME_RE.test(value)) {
    throw fail('invalid-args', `${label} '${String(value)}' must be lowercase letters, digits and single hyphens`);
  }
}

/** Resolve a path that must already exist inside PLUGINS_DIR. */
function contained(absolute: string): string {
  const real = resolveContainedAbsolutePath(PLUGINS_DIR, absolute);
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

export function pluginDirPath(id: string): string {
  assertName('plugin id', id);
  const dir = contained(path.join(PLUGINS_DIR, id));
  if (!isDirectoryPath(dir)) throw fail('not-found', `Unknown plugin: '${id}'`);
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

export interface SkillSource {
  /** Path relative to the plugins root, for display. */
  path: string;
  content: string;
  baseHash: string;
}

export function readSkillSource(pluginId: string, skill: string): SkillSource {
  const file = skillFilePath(pluginId, skill);
  const content = fs.readFileSync(file, 'utf8');
  return {
    path: path.posix.join('plugins', pluginId, 'skills', skill, 'SKILL.md'),
    content,
    baseHash: sha256(content),
  };
}

/** Optimistic concurrency, same contract as saveEntity: the caller passes the hash of the bytes it
 *  started from, and a mismatch means someone else — a hand edit, another tab, plugin-sync — wrote
 *  in between. Silently overwriting that is how edits disappear without anyone noticing. */
export function writeSkillSource(
  pluginId: string,
  skill: string,
  content: string,
  baseHash: string,
): { baseHash: string } {
  const file = skillFilePath(pluginId, skill);
  const current = fs.readFileSync(file, 'utf8');
  if (sha256(current) !== baseHash) {
    throw fail('conflict', `'${pluginId}/${skill}' changed on disk`);
  }
  atomicWriteSync(file, content);
  return { baseHash: sha256(content) };
}

export function skillTemplate(skill: string, description: string): string {
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

export function createSkill(pluginId: string, skill: string, description: string): void {
  assertName('skill name', skill);
  if (description.trim().length === 0) throw fail('invalid-args', 'description must not be empty');
  const skillsRoot = containedTarget(path.join(pluginDirPath(pluginId), 'skills'));
  const dir = containedTarget(path.join(skillsRoot, skill));
  if (lstatExists(dir)) throw fail('invalid-args', `Skill '${pluginId}/${skill}' already exists`);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(path.join(dir, 'SKILL.md'), skillTemplate(skill, description.trim()));
}

/** Rewrite the frontmatter `name` so it keeps agreeing with the directory, which is the one
 *  disagreement the loader still treats as fatal. Everything else in the file is left alone. */
function renameInFrontmatter(content: string, skill: string): string {
  return content.replace(/^(---\r?\n[\s\S]*?)^name:.*$/m, `$1name: ${skill}`);
}

export function moveSkill(
  from: { pluginId: string; skill: string },
  to: { pluginId: string; skill: string },
): void {
  assertName('skill name', to.skill);
  const source = skillDirPath(from.pluginId, from.skill);
  const file = skillFilePath(from.pluginId, from.skill);
  const skillsRoot = containedTarget(path.join(pluginDirPath(to.pluginId), 'skills'));
  const target = containedTarget(path.join(skillsRoot, to.skill));
  if (target === source) throw fail('invalid-args', 'source and destination are the same skill');
  if (lstatExists(target)) throw fail('invalid-args', `Skill '${to.pluginId}/${to.skill}' already exists`);
  if (from.skill !== to.skill) {
    atomicWriteSync(file, renameInFrontmatter(fs.readFileSync(file, 'utf8'), to.skill));
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
}

export function removeSkill(pluginId: string, skill: string): void {
  fs.rmSync(skillDirPath(pluginId, skill), { recursive: true, force: true });
}

export function portableManifestText(id: string, description: string): string {
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
  if (lstatExists(dir)) throw fail('invalid-args', `Plugin '${id}' already exists`);
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  atomicWriteSync(path.join(dir, 'plugin.json'), portableManifestText(id, description));
}

export function removePlugin(id: string): void {
  fs.rmSync(pluginDirPath(id), { recursive: true, force: true });
}

/** Give a legacy plugin the root manifest that portable discovery needs, reusing the legacy
 *  manifest's own fields. The legacy file stays: plugin-sync reads its version and nothing else. */
export function convertToPortable(id: string): void {
  const dir = pluginDirPath(id);
  const root = path.join(dir, 'plugin.json');
  if (lstatExists(root)) throw fail('invalid-args', `Plugin '${id}' already has a root plugin.json`);
  const legacyPath = path.join(dir, '.claude-plugin', 'plugin.json');
  const legacy = lstatExists(legacyPath) ? readJson(contained(legacyPath)) : null;
  const body: Record<string, unknown> = {
    $schema: AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL,
    name: id,
    version: typeof legacy?.version === 'string' ? legacy.version : '0.1.0',
  };
  if (typeof legacy?.description === 'string') body.description = legacy.description;
  atomicWriteSync(containedTarget(root), `${JSON.stringify(body, null, 2)}\n`);
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mcpPath(pluginId: string): string {
  return path.join(pluginDirPath(pluginId), 'mcp.json');
}

/** The raw envelope, secrets included. Only the ui-service redaction layer may see this — it must
 *  never be returned to a browser unfiltered (that is the whole point of PLUGIN_MCP_RUNTIME). */
export function readMcpEnvelope(pluginId: string): Record<string, unknown> {
  const file = mcpPath(pluginId);
  if (!lstatExists(file)) return {};
  const parsed = readJson(contained(file));
  if (!parsed) throw fail('invalid-args', `'${pluginId}/mcp.json' is not valid JSON`);
  const servers = parsed.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers)
    ? servers as Record<string, unknown>
    : {};
}

export function writeMcpEnvelope(pluginId: string, servers: Record<string, unknown>): void {
  const envelope = { $schema: AGENT_PLUGIN_V1_MCP_SCHEMA_URL, mcpServers: servers };
  const parsed = portableMcpSchema.safeParse(envelope);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw fail('invalid-args', `mcp.json would be invalid: ${detail}`);
  }
  atomicWriteSync(containedTarget(mcpPath(pluginId)), `${JSON.stringify(envelope, null, 2)}\n`);
}
