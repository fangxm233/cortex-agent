import { getSettings } from '@core/settings.js';
import path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from '@core/paths.js';
import { CHANNEL_SCOPED_PLUGINS } from '@domain/runs/engine-spec.js';
import { builtinPluginsApply, type EnvironmentPluginFields } from '@domain/plugins/builtin.js';
import { loadPluginCatalog } from '@domain/plugins/catalog.js';
import { realPath } from '@domain/plugins/fs-helpers.js';
import type { PluginCatalogEntry } from '@domain/plugins/catalog-types.js';
import type { UiPluginCatalogEntry } from './types.js';

export interface PluginCatalogSnapshot {
  entries: PluginCatalogEntry[];
  byId: Map<string, PluginCatalogEntry>;
  /** A plugin's `plugins/<id>` address, and its real path when it has a user layer, to its id. */
  pathToId: Map<string, string>;
}

export interface NormalizedPluginDirs {
  managedIds: string[];
  unmanaged: string[];
}

interface NormalizedPluginDirState extends NormalizedPluginDirs {
  seen: Set<string>;
}

type PluginDirResolution =
  | { kind: 'managed'; id: string }
  | { kind: 'unmanaged'; value: string };

function configPathForPluginDir(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(DATA_DIR, value);
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isAssignable(entry: PluginCatalogEntry | undefined): boolean {
  return entry?.valid === true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function pluginDirsOf(value: unknown): unknown {
  return value && typeof value === 'object' ? (value as { pluginDirs?: unknown }).pluginDirs : undefined;
}

function pluginDirValues(pluginDirs: unknown): string[] {
  return Array.isArray(pluginDirs) ? pluginDirs.filter(isNonEmptyString) : [];
}

function resolvePluginDir(
  value: string,
  snapshot: PluginCatalogSnapshot,
): PluginDirResolution {
  const absolute = configPathForPluginDir(value);
  const real = realPath(absolute);
  const id = snapshot.pathToId.get(absolute) ?? (real ? snapshot.pathToId.get(real) : undefined);
  return id ? { kind: 'managed', id } : { kind: 'unmanaged', value };
}

function normalizedPluginDirState(): NormalizedPluginDirState {
  return { managedIds: [], unmanaged: [], seen: new Set<string>() };
}

function appendManagedPluginId(state: NormalizedPluginDirState, id: string): void {
  if (state.seen.has(id)) return;
  state.seen.add(id);
  state.managedIds.push(id);
}

function appendPluginDirResolution(
  state: NormalizedPluginDirState,
  resolution: PluginDirResolution,
): void {
  if (resolution.kind === 'managed') appendManagedPluginId(state, resolution.id);
  else state.unmanaged.push(resolution.value);
}

function finalizeNormalizedPluginDirs(state: NormalizedPluginDirState): NormalizedPluginDirs {
  return { managedIds: state.managedIds, unmanaged: state.unmanaged };
}

function safeServerSummary(server: PluginCatalogEntry['mcp']['servers'][number]) {
  if (server.type === 'stdio') {
    return { name: server.name, type: server.type, summary: { ...server.summary } };
  }
  return { name: server.name, type: server.type, summary: { ...server.summary } };
}

export function readPluginCatalogSnapshot(): PluginCatalogSnapshot {
  const entries = loadPluginCatalog().sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const pathToId = new Map<string, string>();
  for (const entry of entries) {
    const address = path.join(PLUGINS_DIR, entry.id);
    pathToId.set(address, entry.id);
    const real = realPath(address);
    if (real) pathToId.set(real, entry.id);
  }
  return { entries, byId, pathToId };
}

/** Assignment is not the last word on whether a plugin loads: `filterScopedPlugins` drops scoped
 *  plugins again at spawn time. Surfacing the rule here keeps that second gate from being invisible
 *  knowledge the operator has to rediscover by debugging a session that silently lacks a skill. */
function pluginScope(id: string): Pick<UiPluginCatalogEntry, 'scope' | 'scopePrefix'> {
  if (id === 'cortex-feishu' && getSettings().feishuSkillsInWeb) return { scope: 'channel', scopePrefix: 'feishu: / web:' };
  const rule = CHANNEL_SCOPED_PLUGINS.find((candidate) => candidate.plugin === id);
  return rule ? { scope: 'channel', scopePrefix: rule.channelPrefix } : { scope: 'always' };
}

/** Where a skill comes from, per the catalog; null when the catalog does not list it. */
export function skillOrigin(
  snapshot: PluginCatalogSnapshot,
  pluginId: string,
  skill: string,
): PluginCatalogEntry['skills'][number]['origin'] | null {
  return snapshot.byId.get(pluginId)?.skills.find((candidate) => candidate.name === skill)?.origin ?? null;
}

export function sanitizePluginEntry(entry: PluginCatalogEntry): UiPluginCatalogEntry {
  return {
    ...pluginScope(entry.id),
    id: entry.id,
    kind: entry.kind,
    origin: entry.origin,
    rootDir: entry.rootDir,
    valid: entry.valid,
    assignable: isAssignable(entry),
    manifest: { ...entry.manifest },
    skills: entry.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      origin: skill.origin,
    })),
    mcp: {
      status: entry.mcp.status,
      servers: entry.mcp.servers.map((server) => safeServerSummary(server)),
    },
    issues: entry.issues.map((issue) => ({ ...issue })),
  };
}

export function normalizePluginDirs(
  pluginDirs: unknown,
  snapshot: PluginCatalogSnapshot,
): NormalizedPluginDirs {
  const state = normalizedPluginDirState();
  for (const value of pluginDirValues(pluginDirs)) {
    appendPluginDirResolution(state, resolvePluginDir(value, snapshot));
  }
  return finalizeNormalizedPluginDirs(state);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function builtinIds(snapshot: PluginCatalogSnapshot): string[] {
  return snapshot.entries.filter((entry) => entry.origin === 'builtin').map((entry) => entry.id);
}

/** The catalog plugins an environment loads: those its `pluginDirs` lists, then every built-in it
 *  does not opt out of — unless built-ins do not apply to it (skills off). */
export function environmentPlugins(body: unknown, snapshot: PluginCatalogSnapshot): NormalizedPluginDirs {
  const listed = normalizePluginDirs(pluginDirsOf(body), snapshot);
  const fields = (body ?? {}) as EnvironmentPluginFields;
  if (!builtinPluginsApply(fields)) return listed;
  const disabled = new Set(stringList(fields.disabledPlugins));
  const implicit = builtinIds(snapshot).filter((id) => !disabled.has(id));
  return { managedIds: dedupe([...listed.managedIds, ...implicit]), unmanaged: listed.unmanaged };
}

function setOrDrop(body: Record<string, unknown>, key: string, values: string[]): void {
  if (values.length > 0) body[key] = values;
  else delete body[key];
}

/** The environment body that loads exactly `desired` (plus its unmanaged directories). A built-in
 *  is on by default, so switching one off records it in `disabledPlugins` rather than `pluginDirs`;
 *  entries there that name no built-in are kept as they are. */
export function withPluginSelection(
  body: Record<string, unknown>,
  desired: readonly string[],
  unmanaged: readonly string[],
  snapshot: PluginCatalogSnapshot,
): Record<string, unknown> {
  const next = { ...body };
  const implicit = builtinPluginsApply(body as EnvironmentPluginFields) ? builtinIds(snapshot) : [];
  const listed = desired.filter((id) => !implicit.includes(id));
  setOrDrop(next, 'pluginDirs', [...canonicalManagedPluginDirs(listed), ...unmanaged]);
  if (implicit.length === 0) return next;
  const kept = stringList(body.disabledPlugins).filter((id) => !implicit.includes(id));
  setOrDrop(next, 'disabledPlugins', [...kept, ...implicit.filter((id) => !desired.includes(id))]);
  return next;
}

export function canonicalManagedPluginDirs(pluginIds: readonly string[]): string[] {
  return dedupe(pluginIds).map((id) => path.posix.join('plugins', id));
}

export function normalizedDesiredPluginIds(pluginIds: readonly string[]): string[] {
  return dedupe(pluginIds.filter((id): id is string => typeof id === 'string' && id.length > 0));
}

export function addedInvalidPluginIds(
  currentIds: readonly string[],
  desiredIds: readonly string[],
  snapshot: PluginCatalogSnapshot,
): string[] {
  const current = new Set(currentIds);
  return normalizedDesiredPluginIds(desiredIds).filter((id) => {
    const entry = snapshot.byId.get(id);
    return !entry || (!isAssignable(entry) && !current.has(id));
  });
}

export function addedMcpPluginIds(
  currentIds: readonly string[],
  desiredIds: readonly string[],
  snapshot: PluginCatalogSnapshot,
): string[] {
  const current = new Set(currentIds);
  return normalizedDesiredPluginIds(desiredIds).filter((id) => {
    if (current.has(id)) return false;
    return (snapshot.byId.get(id)?.mcp.servers.length ?? 0) > 0;
  });
}
