// input:  skill and plugin authoring args from the Plugins page
// output: SKILL.md writes, skill/plugin lifecycle, and MCP server writes
// pos:    Mutate handlers for the plugin package manager (assignment lives in mutate/plugins.ts)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  convertToPortable,
  createPlugin,
  createSkill,
  moveSkill,
  readMcpEnvelope,
  removePlugin,
  removeSkill,
  writeMcpEnvelope,
  writeSkillSource,
} from '@domain/plugins/authoring.js';
import { readMcpDrafts } from '../query/plugin-source.js';
import { pluginOrigin, readPluginCatalogSnapshot } from '../plugins-shared.js';
import { handlePluginsList } from '../query/plugins.js';
import type {
  PluginsConvertArgs,
  PluginsCreateArgs,
  PluginsMcpRead,
  PluginsMcpServerInput,
  PluginsMcpWriteArgs,
  PluginsPackageReturn,
  PluginsRemoveArgs,
  PluginsSkillCreateArgs,
  PluginsSkillMoveArgs,
  PluginsSkillRemoveArgs,
  PluginsSkillReturn,
  PluginsSkillWriteArgs,
  PluginsSkillWriteReturn,
  Result,
  UiServiceDeps,
} from '../types.js';

type KnownCode = 'invalid-args' | 'not-found' | 'conflict';

function fail(code: KnownCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function toErr(error: unknown): Result<never> {
  const code = (error as { code?: unknown }).code;
  return {
    ok: false,
    code: code === 'invalid-args' || code === 'not-found' || code === 'conflict' ? String(code) : 'internal',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function guarded<T>(run: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return toErr(error);
  }
}

export async function handlePluginsSkillWrite(
  _deps: UiServiceDeps,
  args: PluginsSkillWriteArgs,
): Promise<Result<PluginsSkillWriteReturn>> {
  return guarded(() => writeSkillSource(args.pluginId, args.skill, args.content, args.baseHash));
}

export async function handlePluginsSkillCreate(
  _deps: UiServiceDeps,
  args: PluginsSkillCreateArgs,
): Promise<Result<PluginsSkillReturn>> {
  return guarded(() => {
    createSkill(args.pluginId, args.skill, args.description);
    return { pluginId: args.pluginId, skill: args.skill };
  });
}

export async function handlePluginsSkillMove(
  _deps: UiServiceDeps,
  args: PluginsSkillMoveArgs,
): Promise<Result<PluginsSkillReturn>> {
  return guarded(() => {
    moveSkill(
      { pluginId: args.pluginId, skill: args.skill },
      { pluginId: args.toPluginId, skill: args.toSkill },
    );
    return { pluginId: args.toPluginId, skill: args.toSkill };
  });
}

export async function handlePluginsSkillRemove(
  _deps: UiServiceDeps,
  args: PluginsSkillRemoveArgs,
): Promise<Result<PluginsSkillReturn>> {
  return guarded(() => {
    removeSkill(args.pluginId, args.skill);
    return { pluginId: args.pluginId, skill: args.skill };
  });
}

export async function handlePluginsCreate(
  _deps: UiServiceDeps,
  args: PluginsCreateArgs,
): Promise<Result<PluginsPackageReturn>> {
  return guarded(() => {
    createPlugin(args.id, args.description ?? '');
    return { id: args.id };
  });
}

/** Every agent and template slot that still points at this plugin. Removing a referenced plugin
 *  would leave a dangling pluginDirs entry that only shows up as a missing skill at spawn time. */
async function pluginReferences(deps: UiServiceDeps, id: string): Promise<string[]> {
  const { targets } = await handlePluginsList(deps, {});
  return targets.flatMap((target) => {
    if (target.kind === 'template-shell') return [];
    if (!target.managedPluginIds.includes(id)) return [];
    return [target.kind === 'agent' ? target.name : `${target.templateName}[${target.index}]`];
  });
}

export async function handlePluginsRemove(
  deps: UiServiceDeps,
  args: PluginsRemoveArgs,
): Promise<Result<PluginsPackageReturn>> {
  return guarded(async () => {
    if (pluginOrigin(args.id) === 'managed') {
      throw fail('invalid-args', `'${args.id}' is shipped by Cortex and would be redeployed on the next update`);
    }
    const used = await pluginReferences(deps, args.id);
    if (used.length > 0) throw fail('invalid-args', `'${args.id}' is still assigned to: ${used.join(', ')}`);
    removePlugin(args.id);
    return { id: args.id };
  });
}

export async function handlePluginsConvertToPortable(
  _deps: UiServiceDeps,
  args: PluginsConvertArgs,
): Promise<Result<PluginsPackageReturn>> {
  return guarded(() => {
    const entry = readPluginCatalogSnapshot().byId.get(args.id);
    if (!entry) throw fail('not-found', `Unknown plugin: '${args.id}'`);
    if (entry.kind === 'portable') throw fail('invalid-args', `'${args.id}' is already portable`);
    convertToPortable(args.id);
    return { id: args.id };
  });
}

function secretMap(
  patch: Record<string, string | null> | undefined,
  existing: Record<string, unknown>,
  label: string,
): Record<string, string> | undefined {
  if (!patch) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    const kept = existing[key];
    if (typeof kept !== 'string') {
      throw fail('invalid-args', `${label} '${key}' has no stored value to keep; provide one`);
    }
    out[key] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function existingSecrets(stored: unknown, field: 'env' | 'headers'): Record<string, unknown> {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const value = (stored as Record<string, unknown>)[field];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildServer(input: PluginsMcpServerInput, stored: unknown): Record<string, unknown> {
  if (input.type === 'stdio') {
    const server: Record<string, unknown> = { type: 'stdio', command: input.command ?? '' };
    if (input.args && input.args.length > 0) server.args = input.args;
    if (input.cwd) server.cwd = input.cwd;
    const env = secretMap(input.env, existingSecrets(stored, 'env'), 'env key');
    if (env) server.env = env;
    return server;
  }
  const server: Record<string, unknown> = { type: input.type, url: input.url ?? '' };
  const headers = secretMap(input.headers, existingSecrets(stored, 'headers'), 'header');
  if (headers) server.headers = headers;
  return server;
}

function duplicateName(servers: readonly PluginsMcpServerInput[]): string | null {
  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server.name)) return server.name;
    seen.add(server.name);
  }
  return null;
}

export async function handlePluginsMcpWrite(
  _deps: UiServiceDeps,
  args: PluginsMcpWriteArgs,
): Promise<Result<PluginsMcpRead>> {
  return guarded(() => {
    const duplicate = duplicateName(args.servers);
    if (duplicate) throw fail('invalid-args', `Duplicate MCP server name: '${duplicate}'`);
    const current = readMcpEnvelope(args.pluginId);
    const next: Record<string, unknown> = {};
    for (const server of args.servers) {
      next[server.name] = buildServer(server, current[server.name]);
    }
    writeMcpEnvelope(args.pluginId, next);
    return readMcpDrafts(args.pluginId);
  });
}
