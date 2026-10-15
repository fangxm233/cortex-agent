import { parse } from 'dotenv';
import { isDebugMode } from '@core/debug-mode.js';
import fs from 'node:fs/promises';
import { readPlatformSettings } from '../platform-settings.js';
import path from 'node:path';
import { CONFIG_DIR } from '@core/paths.js';
import { getSettingsSnapshot } from '@core/settings.js';
import { getLocale } from '@core/i18n.js';
import { langSource } from '@domain/system/preferences.js';
import { defaultHookRegistryDirs, loadMountedHookSummaries } from '@store/hook-registry.js';
import { ENVIRONMENTS_DIRNAME } from '@domain/agents/environments/paths.js';
import type {
  UiServiceDeps,
  ConfigLang,
  ConfigSnapshot,
  ConfigBudget,
  ConfigModels,
  ConfigMachine,
  ConfigMcp,
  ConfigAgentEntry,
  ConfigEnvEntry,
  ConfigSettingEntry,
  QueryParams,
} from '../types.js';
import { engineSelectionInput, modelRefInput } from '../input-schemas.js';

const MASK = '••••••••';

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The execution environments (`config/environments/`), read as documents rather than filenames: a
 *  picker has to say what each environment is for. Read under
 *  `configDir`, so the snapshot stays hermetic; a malformed file is skipped rather than failing the
 *  whole snapshot. */
async function readAgentEntries(dir: string, names: readonly string[]): Promise<ConfigAgentEntry[]> {
  const entries = await Promise.all(names.map(async (name): Promise<ConfigAgentEntry | null> => {
    const raw = await readJson(path.join(dir, `${name}.json`));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const doc = raw as Record<string, unknown>;
    const description = typeof doc.description === 'string' && doc.description ? doc.description : undefined;
    return { name, ...(description ? { description } : {}) };
  }));
  return entries.filter((entry): entry is ConfigAgentEntry => entry !== null);
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

// Per-project overrides are pair-only: an entry missing either limit is dropped rather than
// surfaced half-null, so the panel can never render an override that does not fully exist.
function parseProjectBudgets(raw: unknown): Record<string, { daily_usd: number; monthly_usd: number }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, { daily_usd: number; monthly_usd: number }> = {};
  for (const [id, value] of Object.entries(raw as Record<string, any>)) {
    if (!id || !value || typeof value !== 'object') continue;
    if (typeof value.daily_usd !== 'number' || typeof value.monthly_usd !== 'number') continue;
    out[id] = { daily_usd: value.daily_usd, monthly_usd: value.monthly_usd };
  }
  return out;
}

function parseBudget(raw: any): ConfigBudget | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    daily_usd: typeof raw.daily_usd === 'number' ? raw.daily_usd : null,
    monthly_usd: typeof raw.monthly_usd === 'number' ? raw.monthly_usd : null,
    projects: parseProjectBudgets(raw.projects),
  };
}

function parseModels(raw: unknown): ConfigModels {
  const file = raw as { default?: unknown; favorites?: unknown } | null;
  const selection = engineSelectionInput.safeParse(file?.default);
  const favorites = Array.isArray(file?.favorites) ? file.favorites : [];
  return {
    default: selection.success ? selection.data : null,
    favorites: favorites.flatMap((ref) => {
      const parsed = modelRefInput.safeParse(ref);
      return parsed.success ? [parsed.data] : [];
    }),
    memory: {},
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

// Redact values while reporting whether the DEBUG flag is enabled.
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
    entries.push({ key, present, masked: present ? MASK : '',
      ...(key === 'DEBUG' ? { enabled: isDebugMode(parse(text)) } : {}),
    });
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
 * Read a config snapshot from the supplied directory. Files remain hermetically scoped to that
 * directory plus `builtinHooksDir` (the shipped hook registrations, merged under the user's);
 * settings and the display language are the live values the caller supplies. A missing or
 * malformed source affects only its own field.
 */
export async function readConfigSnapshot(
  configDir: string,
  liveSettings: ConfigSettingEntry[],
  lang: ConfigLang,
  builtinHooksDir: string | null = defaultHookRegistryDirs().builtin,
): Promise<ConfigSnapshot> {
  const hooks = loadMountedHookSummaries({ user: path.join(configDir, 'hooks'), builtin: builtinHooksDir });
  const parts = await Promise.all([
    readJson(path.join(configDir, 'budget.json')),
    readJson(path.join(configDir, 'models.json')),
    readJson(path.join(configDir, 'machines.json')),
    readJson(path.join(configDir, 'mcp-config.json')),
    readEnv(path.join(configDir, '.env')),
    listJsonBasenames(path.join(configDir, ENVIRONMENTS_DIRNAME)),
  ]);
  const [budget, models, machines, mcp, env, environments] = parts;
  return {
    platforms: await readPlatformSettings(path.join(configDir, '.env')),
    budget: parseBudget(budget), models: parseModels(models), machines: parseMachines(machines),
    selectionDefault: null,
    mcp: parseMcp(mcp),
    agents: await readAgentEntries(path.join(configDir, ENVIRONMENTS_DIRNAME), environments),
    hooks, env, settings: liveSettings, lang,
  };
}

export async function handleConfigGet(deps: UiServiceDeps, _params: QueryParams<'config.get'>): Promise<ConfigSnapshot> {
  // `value` is the LIVE process locale, not the file: a `!lang` switch takes effect without a
  // restart, and the UI must follow what Cortex is actually speaking. `source` is read from disk
  // and the environment, and is the only thing that can say "CORTEX_LANG will win again at boot".
  const snapshot = await readConfigSnapshot(
    CONFIG_DIR, getSettingsSnapshot(), { value: getLocale(), source: langSource() },
  );
  return {
    ...snapshot,
    models: { ...snapshot.models, memory: deps.getModelMemory() },
    selectionDefault: deps.getSelectionDefault() ?? null,
  };
}
