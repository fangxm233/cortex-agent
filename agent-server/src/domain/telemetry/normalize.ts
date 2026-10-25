import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANTHROPIC_MODELS } from '@core/anthropic-models.js';
import { loadPiSdk } from '@core/pi-sdk.js';
import { readCustomProviderEntries, USER_PI_MODELS_PATH } from '@domain/pi-providers/models-json-store.js';
import { TELEMETRY_CUSTOM, TELEMETRY_MCP_OTHER, TELEMETRY_OTHER } from './schema.js';

/**
 * Public names an upload may carry: the PI SDK's bundled static catalog plus Cortex's own Claude
 * list. Anything else a user configured (custom providers, local or dynamically listed models,
 * third-party MCP tools) is replaced by a placeholder.
 */
export interface NameCatalog {
  piProviders: ReadonlySet<string>;
  /** `provider/model` pairs from the static catalog. */
  piModels: ReadonlySet<string>;
  /** Every model id in the static catalog, any provider (gateway-routed Claude Code). */
  modelIds: ReadonlySet<string>;
  /** User-defined PI providers (models.json) → their API kind. */
  customProviders: ReadonlyMap<string, string>;
}

/** Built-in tool names of Claude Code and PI (plus the tools Cortex registers on PI). */
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite', 'Skill', 'Agent', 'Task',
  'TaskOutput', 'TaskStop', 'NotebookEdit', 'NotebookRead', 'BashOutput', 'KillShell', 'KillBash',
  'SlashCommand', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'bash', 'read', 'write', 'edit', 'grep', 'glob', 'find', 'ls', 'powershell', 'web_fetch',
  'web_search', 'todo_write', 'skill', 'agent', 'agent_stop',
]);

const NOT_IDENT_CHARS = /[^A-Za-z0-9._:/@[\]-]/g;

/** A public name made to fit the wire identifier shape. */
export function toIdent(name: string): string {
  return name.replace(NOT_IDENT_CHARS, '_').slice(0, 80) || TELEMETRY_OTHER;
}

export function normalizeTool(name: string): string {
  if (BUILTIN_TOOLS.has(name)) return name;
  if (name.startsWith('mcp__cortex-')) return toIdent(name);
  return name.startsWith('mcp__') ? TELEMETRY_MCP_OTHER : TELEMETRY_OTHER;
}

export interface NormalizedProvider {
  provider: string;
  customApi: string | null;
}

export function normalizeProvider(
  backend: 'claude' | 'pi', provider: string, catalog: NameCatalog,
): NormalizedProvider {
  if (backend === 'claude') return { provider: 'anthropic', customApi: null };
  if (catalog.customProviders.has(provider)) {
    return { provider: TELEMETRY_CUSTOM, customApi: toIdent(catalog.customProviders.get(provider)!) };
  }
  return { provider: catalog.piProviders.has(provider) ? provider : TELEMETRY_OTHER, customApi: null };
}

export function normalizeModel(
  backend: 'claude' | 'pi', provider: string, model: string, catalog: NameCatalog,
): string {
  if (backend === 'claude') {
    const known = ANTHROPIC_MODELS.includes(model) || catalog.modelIds.has(model.replace(/\[1m\]$/, ''));
    return known ? toIdent(model) : TELEMETRY_OTHER;
  }
  if (catalog.customProviders.has(provider)) return TELEMETRY_CUSTOM;
  return catalog.piModels.has(`${provider}/${model}`) ? toIdent(model) : TELEMETRY_OTHER;
}

/** Heartbeat provider list: built-ins as-is, user-defined ones as `custom`, deduplicated. */
export function normalizeProviderList(providers: string[], catalog: NameCatalog): string[] {
  return [...new Set(providers.map((name) => normalizeProvider('pi', name, catalog).provider))];
}

interface CatalogModel { provider: string; id: string }

function customProviderApis(modelsPath: string): Map<string, string> {
  const entries = readCustomProviderEntries(modelsPath);
  return new Map(Object.entries(entries).map(([name, entry]) => [name, String(entry.api)]));
}

/** Read the SDK's bundled catalog without the user's auth, models.json or network. */
async function loadStaticModels(): Promise<CatalogModel[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-telemetry-catalog-'));
  try {
    const authPath = path.join(dir, 'auth.json');
    writeFileSync(authPath, '');
    const sdk = await loadPiSdk();
    const runtime = await sdk.ModelRuntime.create({
      authPath, modelsPath: path.join(dir, 'absent', 'models.json'), allowModelNetwork: false,
    });
    return runtime.getAllModels().map((model) => ({ provider: String(model.provider), id: String(model.id) }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function buildNameCatalog(models: CatalogModel[], customProviders: Map<string, string>): NameCatalog {
  return {
    piProviders: new Set(models.map((model) => model.provider)),
    piModels: new Set(models.map((model) => `${model.provider}/${model.id}`)),
    modelIds: new Set(models.map((model) => model.id)),
    customProviders,
  };
}

let cached: { day: string; catalog: Promise<NameCatalog> } | null = null;

/** Built once per UTC day, at the first upload that needs it; never on a turn's hot path. */
export function loadNameCatalog(day: string, modelsPath: string = USER_PI_MODELS_PATH): Promise<NameCatalog> {
  if (cached?.day === day) return cached.catalog;
  const catalog = loadStaticModels()
    .catch(() => [] as CatalogModel[])
    .then((models) => buildNameCatalog(models, customProviderApis(modelsPath)));
  cached = { day, catalog };
  return catalog;
}
