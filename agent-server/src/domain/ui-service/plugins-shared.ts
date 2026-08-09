// input:  plugin catalog, pluginDirs, data paths
// output: catalog snapshots and plugin-dir helpers
// pos:    Shared plugin helpers for ui-service
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from '@core/paths.js';
import { loadPluginCatalog } from '@domain/plugins/catalog.js';
import type { PluginCatalogEntry } from '@domain/plugins/catalog-types.js';
import type { UiPluginCatalogEntry } from './types.js';

export interface PluginCatalogSnapshot {
  entries: PluginCatalogEntry[];
  byId: Map<string, PluginCatalogEntry>;
  realpathToId: Map<string, string>;
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

function realpathIfExists(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

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

function pluginDirValues(pluginDirs: unknown): string[] {
  return Array.isArray(pluginDirs) ? pluginDirs.filter(isNonEmptyString) : [];
}

function resolvePluginDir(
  value: string,
  snapshot: PluginCatalogSnapshot,
): PluginDirResolution {
  const real = realpathIfExists(configPathForPluginDir(value));
  const id = real ? snapshot.realpathToId.get(real) ?? null : null;
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

function catalogRealpath(id: string): string | null {
  return realpathIfExists(path.join(PLUGINS_DIR, id));
}

export function readPluginCatalogSnapshot(): PluginCatalogSnapshot {
  const entries = loadPluginCatalog().sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const realpathToId = new Map<string, string>();
  for (const entry of entries) {
    const real = catalogRealpath(entry.id);
    if (real) realpathToId.set(real, entry.id);
  }
  return { entries, byId, realpathToId };
}

export function sanitizePluginEntry(entry: PluginCatalogEntry): UiPluginCatalogEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    rootDir: entry.rootDir,
    valid: entry.valid,
    assignable: isAssignable(entry),
    manifest: { ...entry.manifest },
    skills: entry.skills.map((skill) => ({ name: skill.name })),
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

export function samePluginIds(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizedDesiredPluginIds(left);
  const b = normalizedDesiredPluginIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
