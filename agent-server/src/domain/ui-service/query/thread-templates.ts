// input:  UiServiceDeps + ThreadTemplatesGetParams (empty)
// output: threadTemplates.get handler → ThreadTemplateEntry[] — full body of every
//         thread-template JSON file under config/thread-templates/{templates,agents,shells}/
// pos:    query handler for 'threadTemplates.get' (plan §12 A item 3 / 9c). Pure
//         `readThreadTemplates(configDir)` + thin `handleThreadTemplatesGet` binding CONFIG_DIR.
//         No secrets in template JSON files; body is the full parsed content, null on parse error.
//         Kind order: templates → agents → shells. Within each kind: alphabetical by filename.
// >>> If I am updated, update CORTEX.md <<<

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, DEFAULTS_DIR } from '@core/paths.js';
import { validateRegistry, type RawRegistry } from '@domain/threads/template-validate.js';
import { loaderRefResolver } from '@domain/threads/template-loader.js';
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

const SUBDIR: Record<ThreadTemplateEntry['kind'], string> = {
  template: 'templates',
  agent: 'agents',
  shell: 'shells',
};

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
async function classifyOrigin(
  defaultsRoot: string,
  kind: ThreadTemplateEntry['kind'],
  name: string,
  content: string | null,
): Promise<ThreadTemplateOrigin> {
  const shipped = path.join(defaultsRoot, 'config', 'thread-templates', SUBDIR[kind], `${name}.json`);
  const stock = await fs.readFile(shipped, 'utf8').catch(() => null);
  if (stock === null) return 'custom';
  return stock === content ? 'stock' : 'modified';
}

/**
 * Read all thread-template entries from config/thread-templates/{templates,agents,shells}/*.json.
 * Pure over configDir + defaultsRoot (hermetically testable). Returns templates first, then agents,
 * then shells, each group sorted alphabetically by basename. body is null when the file cannot be
 * parsed. Each entry carries its validation verdict so the list can flag a broken entity without a
 * round trip per row.
 */
export async function readThreadTemplates(
  configDir: string,
  defaultsRoot: string = DEFAULTS_DIR,
): Promise<ThreadTemplateEntry[]> {
  const tt = path.join(configDir, 'thread-templates');
  const [templates, agents, shells] = await Promise.all([
    readEntriesForKind(path.join(tt, 'templates'), 'template'),
    readEntriesForKind(path.join(tt, 'agents'), 'agent'),
    readEntriesForKind(path.join(tt, 'shells'), 'shell'),
  ]);
  const raw = [...templates, ...agents, ...shells];

  const registry: RawRegistry = { agents: {}, templates: {}, shells: {} };
  for (const entry of raw) {
    const bucket =
      entry.kind === 'agent' ? registry.agents : entry.kind === 'template' ? registry.templates : registry.shells;
    bucket[entry.name] = entry.body;
  }
  const verdicts = validateRegistry(registry, loaderRefResolver());

  return Promise.all(
    raw.map(async ({ content, ...entry }) => {
      const errorCount = verdicts.get(`${entry.kind}:${entry.name}`)?.errors.length ?? 0;
      return {
        ...entry,
        valid: errorCount === 0,
        errorCount,
        origin: await classifyOrigin(defaultsRoot, entry.kind, entry.name, content),
      };
    }),
  );
}

export async function handleThreadTemplatesGet(
  _deps: UiServiceDeps,
  _params: ThreadTemplatesGetParams,
): Promise<ThreadTemplateEntry[]> {
  return readThreadTemplates(CONFIG_DIR);
}
