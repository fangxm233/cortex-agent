import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, DEFAULTS_DIR } from '@core/paths.js';
import { validateRegistry, type RawRegistry } from '@domain/threads/template-validate.js';
import { loaderRefResolver } from '@domain/threads/template-loader.js';
import { entityPath } from '@domain/threads/template-writer.js';
import { readEnvironmentEntries } from './environments.js';
import type {
  UiServiceDeps,
  ThreadTemplatesGetParams,
  ThreadTemplateEntry,
  ThreadTemplateOrigin,
} from '../types.js';

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface RawEntry {
  kind: ThreadTemplateEntry['kind'];
  name: string;
  description: string | null;
  body: Record<string, unknown> | null;
  /** Exact bytes on disk, for the defaults comparison. */
  content: string | null;
}

async function readEntriesForKind(dir: string, kind: ThreadTemplateEntry['kind']): Promise<RawEntry[]> {
  try {
    const files = await fs.readdir(dir);
    const jsonFiles = files.filter((f) => f.endsWith('.json')).sort();
    return Promise.all(
      jsonFiles.map(async (f) => {
        const name = f.slice(0, -'.json'.length);
        const filePath = path.join(dir, f);
        const content = await fs.readFile(filePath, 'utf8').catch(() => null);
        const body = await readJson(filePath);
        const description =
          body && typeof body.description === 'string' ? body.description : null;
        return { kind, name, description, body, content };
      }),
    );
  } catch {
    return [];
  }
}

/**
 * Relationship to the shipped default of the same name. `mergeThreadTemplates` is copy-if-missing
 * and never overwrites, so a user file that differs has forked from upstream permanently.
 */
export async function classifyOrigin(
  kind: ThreadTemplateEntry['kind'],
  name: string,
  content: string | null,
): Promise<ThreadTemplateOrigin> {
  const shipped = entityPath(path.join(DEFAULTS_DIR, 'config', 'thread-templates'), kind, name);
  const stock = await fs.readFile(shipped, 'utf8').catch(() => null);
  if (stock === null) return 'custom';
  return stock === content ? 'stock' : 'modified';
}

/**
 * Read the editor list: templates and shells from config/thread-templates/{templates,shells}/, and
 * the agents a user edits — the execution environments in config/environments/. Pure over
 * configDir (hermetically testable). Returns templates first, then agents, then shells, each group
 * sorted alphabetically by basename. body is null when the file cannot be parsed. Each entry
 * carries its validation verdict so the list can flag a broken entity without a round trip per row.
 * Templates are validated against the thread agents they name (thread-templates/agents/), which
 * the list no longer shows.
 */
export async function readThreadTemplates(configDir: string): Promise<ThreadTemplateEntry[]> {
  const tt = path.join(configDir, 'thread-templates');
  const [templates, threadAgents, shells, environments] = await Promise.all([
    readEntriesForKind(path.join(tt, 'templates'), 'template'),
    readEntriesForKind(path.join(tt, 'agents'), 'agent'),
    readEntriesForKind(path.join(tt, 'shells'), 'shell'),
    readEnvironmentEntries(configDir),
  ]);

  const registry: RawRegistry = { agents: {}, templates: {}, shells: {} };
  for (const entry of threadAgents) registry.agents[entry.name] = entry.body;
  for (const entry of templates) registry.templates[entry.name] = entry.body;
  for (const entry of shells) registry.shells[entry.name] = entry.body;
  const verdicts = validateRegistry(registry, loaderRefResolver());

  const withVerdict = (entries: RawEntry[]) => Promise.all(
    entries.map(async ({ content, ...entry }) => {
      const errorCount = verdicts.get(`${entry.kind}:${entry.name}`)?.errors.length ?? 0;
      return {
        ...entry,
        valid: errorCount === 0,
        errorCount,
        origin: await classifyOrigin(entry.kind, entry.name, content),
      };
    }),
  );
  return [...await withVerdict(templates), ...environments, ...await withVerdict(shells)];
}

export async function handleThreadTemplatesGet(
  _deps: UiServiceDeps,
  _params: ThreadTemplatesGetParams,
): Promise<ThreadTemplateEntry[]> {
  return readThreadTemplates(CONFIG_DIR);
}
