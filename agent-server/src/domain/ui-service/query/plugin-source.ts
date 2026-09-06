// input:  plugin id plus skill name or MCP request
// output: plugins.skillFile and plugins.mcpRead payloads
// pos:    Read side of the plugin authoring surface
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// mcpRead deliberately carries more than the catalog summary does — a form cannot round-trip a
// command it was never given — but it stops at the same line the catalog does: env and header
// VALUES never leave the server, only their key names.

import { readMcpEnvelope, readSkillSource } from '@domain/plugins/authoring.js';
import { isManagedSkill, readPluginCatalogSnapshot } from '../plugins-shared.js';
import type {
  PluginsMcpRead,
  PluginsMcpReadParams,
  PluginsSkillFile,
  PluginsSkillFileParams,
  UiPluginMcpDraft,
  UiServiceDeps,
} from '../types.js';

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function keysOf(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function draftServer(name: string, raw: unknown): UiPluginMcpDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (body.type === 'streamable-http' || body.type === 'sse') {
    return { name, type: body.type, url: text(body.url), headerKeys: keysOf(body.headers) };
  }
  if (body.type !== 'stdio') return null;
  const draft: UiPluginMcpDraft = {
    name,
    type: 'stdio',
    command: text(body.command),
    args: stringList(body.args),
    envKeys: keysOf(body.env),
  };
  return typeof body.cwd === 'string' ? { ...draft, cwd: body.cwd } : draft;
}

export async function handlePluginsSkillFile(
  _deps: UiServiceDeps,
  params: PluginsSkillFileParams,
): Promise<PluginsSkillFile> {
  const source = readSkillSource(params.pluginId, params.skill);
  return {
    pluginId: params.pluginId,
    skill: params.skill,
    path: source.path,
    content: source.content,
    managed: isManagedSkill(params.pluginId, params.skill),
    baseHash: source.baseHash,
  };
}

export function readMcpDrafts(pluginId: string): PluginsMcpRead {
  const entry = readPluginCatalogSnapshot().byId.get(pluginId);
  const servers = Object.entries(readMcpEnvelope(pluginId))
    .map(([name, raw]) => draftServer(name, raw))
    .filter((server): server is UiPluginMcpDraft => server !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
  return { pluginId, supported: entry?.kind === 'portable', servers };
}

export async function handlePluginsMcpRead(
  _deps: UiServiceDeps,
  params: PluginsMcpReadParams,
): Promise<PluginsMcpRead> {
  return readMcpDrafts(params.pluginId);
}
