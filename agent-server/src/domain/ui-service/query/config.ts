// input:  UiServiceDeps + ConfigGetParams (empty)
// output: config.get handler → redacted ConfigSnapshot of ~/.cortex/config for the settings panel
// pos:    query handler for 'config.get' (Stage 7 settings 12a–g). Pure `readConfigSnapshot`
//         (dir args, hermetic) + thin `handleConfigGet` binding CONFIG_DIR / HOOKS_DIR.
//         SECURITY: never returns .env values or raw machine ssh strings — only redacted markers.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, HOOKS_DIR } from '@core/paths.js';
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
} from '../types.js';

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

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
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

function parseProfiles(raw: any): ConfigProfiles | null {
  if (!raw || typeof raw !== 'object' || !raw.profiles || typeof raw.profiles !== 'object') return null;
  const profiles: ConfigProfileEntry[] = Object.entries(raw.profiles).map(([name, p]: [string, any]) => ({
    name,
    model: typeof p?.model === 'string' ? p.model : null,
    backend: typeof p?.backend === 'string' ? p.backend : null,
    mode: typeof p?.mode === 'string' ? p.mode : null,
    thinking: typeof p?.thinking === 'string' ? p.thinking : null,
  }));
  return {
    defaultProfile: typeof raw.defaultProfile === 'string' ? raw.defaultProfile : null,
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

/**
 * Read a redacted snapshot of the config directory for the settings panel. Pure over its dir
 * arguments (no global paths) so it is hermetically testable against a fixture directory. Every
 * source file is independent: a missing / malformed file yields null (or []) for that field only.
 */
export async function readConfigSnapshot(configDir: string, hooksDir: string): Promise<ConfigSnapshot> {
  const tt = path.join(configDir, 'thread-templates');
  const [budgetRaw, profilesRaw, machinesRaw, mcpRaw, agents, templates, shells, hooks, env] = await Promise.all([
    readJson(path.join(configDir, 'budget.json')),
    readJson(path.join(configDir, 'profiles.json')),
    readJson(path.join(configDir, 'machines.json')),
    readJson(path.join(configDir, 'mcp-config.json')),
    listJsonBasenames(path.join(tt, 'agents')),
    listJsonBasenames(path.join(tt, 'templates')),
    listJsonBasenames(path.join(tt, 'shells')),
    listFiles(hooksDir),
    readEnv(path.join(configDir, '.env')),
  ]);

  const threadTemplates: ConfigThreadTemplates = { agents, templates, shells };
  return {
    budget: parseBudget(budgetRaw),
    profiles: parseProfiles(profilesRaw),
    machines: parseMachines(machinesRaw),
    mcp: parseMcp(mcpRaw),
    threadTemplates,
    hooks,
    env,
  };
}

export async function handleConfigGet(_deps: UiServiceDeps, _params: ConfigGetParams): Promise<ConfigSnapshot> {
  return readConfigSnapshot(CONFIG_DIR, HOOKS_DIR);
}
