// input:  resolved AgentSpawnConfig and plugin directory trees
// output: content-addressed role/tool identity surface
// pos:    Anti-divergence identity projection for one-shot spawns
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildHooksSettings } from '../../agent-adapter/claude/hooks-builder.js';
import type { AgentSpawnConfig } from '../../agent-adapter/types.js';
import {
  canonicalJsonSha256, type IdentityJsonValue, type PluginDirIdentityInput,
  type RoleToolSurfaceInput, type SkillIdentityInput,
} from './identity.js';

interface ContentEntry {
  path: string;
  type: 'file' | 'symlink';
  sha256?: string;
  target?: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function contentEntries(root: string, directory = root): ContentEntry[] {
  const result: ContentEntry[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...contentEntries(root, absolute));
    if (entry.isFile()) {
      result.push({ path: path.relative(root, absolute), type: 'file', sha256: sha256(fs.readFileSync(absolute)) });
    }
    if (entry.isSymbolicLink()) {
      result.push({ path: path.relative(root, absolute), type: 'symlink', target: fs.readlinkSync(absolute) });
    }
  }
  return result;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePath(a: ContentEntry, b: ContentEntry): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

export function directoryContentSha256(directory: string): string {
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error(`Plugin path is not a directory: ${directory}`);
  }
  return canonicalJsonSha256(contentEntries(directory).sort(comparePath));
}

function pluginIdentities(pluginDirs: string[]): PluginDirIdentityInput[] {
  return pluginDirs.map(directory => ({
    path: directory,
    content_sha256: directoryContentSha256(directory),
  })).sort((left, right) => compareText(left.path, right.path));
}

function pluginSkills(pluginDir: string): SkillIdentityInput[] {
  const root = path.join(pluginDir, 'skills');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      content_sha256: directoryContentSha256(path.join(root, entry.name)),
    }));
}

function discoveredSkills(pluginDirs: string[]): SkillIdentityInput[] {
  const skills = pluginDirs.flatMap(pluginSkills);
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) throw new Error(`Duplicate plugin skill name: ${skill.name}`);
    names.add(skill.name);
  }
  return skills.sort((left, right) => compareText(left.name, right.name));
}

function spawnedTools(config: AgentSpawnConfig): string[] {
  if (config.rawTools === undefined) return config.tools ?? [];
  return config.rawTools.length === 0 ? [] : config.rawTools.split(',');
}

function hookPolicy(config: AgentSpawnConfig): IdentityJsonValue {
  if (config.disableHooks === true) return {};
  const tools = spawnedTools(config).join(',');
  return buildHooksSettings(tools) as unknown as IdentityJsonValue;
}

export function roleSurfaceFromSpawnConfig(config: AgentSpawnConfig): RoleToolSurfaceInput {
  const pluginDirs = config.pluginDirs ?? [];
  return {
    systemPromptSha256: sha256(config.systemPrompt ?? ''),
    directiveSha256: sha256(''),
    tools: spawnedTools(config),
    pluginDirs: pluginIdentities(pluginDirs),
    skills: discoveredSkills(pluginDirs),
    mcpComposition: config.mcpComposition ?? 'direct',
    hookPolicy: hookPolicy(config),
  };
}
