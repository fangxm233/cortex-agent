// input:  config root, settings registry, mounted-hook registry
// output: redacted config plus plaintext settings provenance
// pos:    Config.get snapshot reader
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '@core/paths.js';
import { getSettingsSnapshot, resolveSettingsSnapshot } from '@core/settings.js';
import { loadMountedHookSummaries } from '@store/hook-registry.js';
import type {
  UiServiceDeps,
  ConfigGetParams,
  ConfigSnapshot,
  ConfigBudget,
  ConfigProfiles,
  ConfigProfileEntry,
  ConfigMachine,
  ConfigMcp,
  ConfigThreadTemplates,
  ConfigEnvEntry,
  ConfigSettingEntry,
} from '../types.js';
import type { Backend } from '../../../agent-adapter/types.js';

const MASK = '••••••••';

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function listJsonBasenames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

function parseBudget(raw: any): ConfigBudget | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    daily_usd: typeof raw.daily_usd === 'number' ? raw.daily_usd : null,
    monthly_usd: typeof raw.monthly_usd === 'number' ? raw.monthly_usd : null,
  };
}

function isLiveBackend(value: unknown): value is Backend {
  return value === 'claude' || value === 'pi';
}

function parseProfiles(raw: any): ConfigProfiles | null {
  if (!raw || typeof raw !== 'object' || !raw.profiles || typeof raw.profiles !== 'object') return null;
  const profiles = Object.entries(raw.profiles).flatMap(([name, p]: [string, any]): ConfigProfileEntry[] => {
    if (p?.backend != null && !isLiveBackend(p.backend)) return [];
    return [{
      name,
      model: typeof p?.model === 'string' ? p.model : null,
      backend: isLiveBackend(p?.backend) ? p.backend : null,
      mode: typeof p?.mode === 'string' ? p.mode : null,
      thinking: typeof p?.thinking === 'string' ? p.thinking : null,
    }];
  });
  const requestedDefault = typeof raw.defaultProfile === 'string' ? raw.defaultProfile : null;
  return {
    defaultProfile: requestedDefault && profiles.some((profile) => profile.name === requestedDefault)
      ? requestedDefault
      : null,
    profiles,
  };
}

function parseMachines(raw: any): ConfigMachine[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([name, m]: [string, any]) => ({
    name,
    cortexPath: typeof m?.cortexPath === 'string' ? m.cortexPath : null,
    gpuCount: typeof m?.gpuCount === 'number' ? m.gpuCount : null,
    // presence flag only — never return the raw user@host string
    ssh: typeof m?.ssh === 'string' && m.ssh.length > 0,
    win: m?.win === true,
  }));
}

function parseMcp(raw: any): ConfigMcp | null {
  if (!raw || typeof raw !== 'object' || !raw.mcpServers || typeof raw.mcpServers !== 'object') return null;
  return { servers: Object.keys(raw.mcpServers).sort() };
}

// Parse a .env file into redacted entries. Only the key, a present flag, and a fixed mask are
// returned — no character of any value is ever exposed.
function parseEnv(text: string): ConfigEnvEntry[] {
  const entries: ConfigEnvEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    const value = trimmed.slice(eq + 1).trim();
    const present = value.length > 0;
    entries.push({ key, present, masked: present ? MASK : '' });
  }
  return entries;
}

async function readEnv(file: string): Promise<ConfigEnvEntry[]> {
  try {
    return parseEnv(await fs.readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

async function readSettings(configDir: string): Promise<ConfigSettingEntry[]> {
  const raw = await readJson(path.join(configDir, 'settings.json'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return resolveSettingsSnapshot({});
  }
  try {
    return resolveSettingsSnapshot(raw);
  } catch {
    return resolveSettingsSnapshot({});
  }
}

/**
 * Read a config snapshot from the supplied directory. Files remain hermetically scoped to that
 * directory; settings use the process env fallback unless the caller supplies the live cached
 * snapshot. A missing or malformed source affects only its own field.
 */
export async function readConfigSnapshot(
  configDir: string,
  liveSettings?: ConfigSettingEntry[],
): Promise<ConfigSnapshot> {
  const tt = path.join(configDir, 'thread-templates');
  const hooks = loadMountedHookSummaries(path.join(configDir, 'hooks'), path.join(tt, 'templates'));
  const parts = await Promise.all([
    readJson(path.join(configDir, 'budget.json')),
    readJson(path.join(configDir, 'profiles.json')),
    readJson(path.join(configDir, 'machines.json')),
    readJson(path.join(configDir, 'mcp-config.json')),
    listJsonBasenames(path.join(tt, 'agents')),
    listJsonBasenames(path.join(tt, 'templates')),
    listJsonBasenames(path.join(tt, 'shells')),
    readEnv(path.join(configDir, '.env')),
    liveSettings ?? readSettings(configDir),
  ]);
  const [budget, profiles, machines, mcp, agents, templates, shells, env, settings] = parts;
  const threadTemplates: ConfigThreadTemplates = { agents, templates, shells };
  return {
    budget: parseBudget(budget), profiles: parseProfiles(profiles), machines: parseMachines(machines),
    mcp: parseMcp(mcp), threadTemplates, hooks, env, settings,
  };
}

export async function handleConfigGet(_deps: UiServiceDeps, _params: ConfigGetParams): Promise<ConfigSnapshot> {
  return readConfigSnapshot(CONFIG_DIR, getSettingsSnapshot());
}
