import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_ENVIRONMENTS_DIR,
  ENVIRONMENTS_DIR,
  ENVIRONMENTS_DIRNAME,
  fsRefResolver,
  readEnvironment,
  validateEnvironment,
} from '@domain/agents/environments/index.js';
import type { ThreadTemplateDetail, ThreadTemplateEntry, ThreadTemplateOrigin } from '../types.js';

/** Relationship to the shipped environment of the same name. Defaults are copy-if-missing and never
 *  overwrite, so a user file that differs has forked from upstream permanently. */
export async function classifyEnvironmentOrigin(name: string, content: string | null): Promise<ThreadTemplateOrigin> {
  const stock = await fs.readFile(path.join(DEFAULT_ENVIRONMENTS_DIR, `${name}.json`), 'utf8').catch(() => null);
  if (stock === null) return 'custom';
  return stock === content ? 'stock' : 'modified';
}

/** Every environment under `<configDir>/environments/` as an editor list entry (kind `agent`),
 *  sorted by name, each with its validation verdict. Pure over configDir. */
export async function readEnvironmentEntries(configDir: string): Promise<ThreadTemplateEntry[]> {
  const dir = path.join(configDir, ENVIRONMENTS_DIRNAME);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const refs = fsRefResolver();
  return Promise.all(files.map(async (file): Promise<ThreadTemplateEntry> => {
    const name = file.slice(0, -'.json'.length);
    const content = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = content === null ? null : JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
    } catch {
      body = null;
    }
    const errorCount = validateEnvironment(name, body, refs).errors.length;
    return {
      kind: 'agent',
      name,
      description: body && typeof body.description === 'string' ? body.description : null,
      body,
      valid: errorCount === 0,
      errorCount,
      origin: await classifyEnvironmentOrigin(name, content),
    };
  }));
}

/** One environment as the editor opens it: raw body (so `file:` refs survive a round trip), hash,
 *  and validation verdict. Environments have no template dependents. */
export async function readEnvironmentDetail(name: string): Promise<ThreadTemplateDetail> {
  const entity = readEnvironment(ENVIRONMENTS_DIR, name);
  const { errors, warnings } = validateEnvironment(name, entity.body, fsRefResolver());
  return {
    kind: 'agent',
    name,
    description: entity.body && typeof entity.body.description === 'string' ? entity.body.description : null,
    body: entity.body,
    filePath: entity.filePath,
    origin: await classifyEnvironmentOrigin(name, entity.content),
    sha256: entity.sha256,
    errors,
    warnings,
    usedByTemplates: [],
    runningThreads: 0,
    referencingTasks: 0,
    expanded: null,
  };
}
