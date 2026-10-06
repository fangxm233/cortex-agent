import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '@core/paths.js';
import {
  DEFAULT_ENVIRONMENTS_DIR,
  ENVIRONMENTS_DIR,
  ENVIRONMENTS_DIRNAME,
  fsRefResolver,
  readEnvironment,
  validateEnvironment,
} from '@domain/agents/environments/index.js';
import type {
  EnvironmentDetail,
  EnvironmentEntry,
  EnvironmentOrigin,
  UiServiceDeps,
  QueryParams,
} from '../types.js';

/** Relationship to the shipped environment of the same name. Defaults are copy-if-missing and never
 *  overwrite, so a user file that differs has forked from upstream permanently. */
export async function classifyEnvironmentOrigin(name: string, content: string | null): Promise<EnvironmentOrigin> {
  const stock = await fs.readFile(path.join(DEFAULT_ENVIRONMENTS_DIR, `${name}.json`), 'utf8').catch(() => null);
  if (stock === null) return 'custom';
  return stock === content ? 'stock' : 'modified';
}

function descriptionOf(body: Record<string, unknown> | null): string | null {
  return body && typeof body.description === 'string' ? body.description : null;
}

/** Every environment under `<configDir>/environments/` as an editor list entry, sorted by name, each
 *  with its validation verdict. Pure over configDir. */
export async function readEnvironmentEntries(configDir: string): Promise<EnvironmentEntry[]> {
  const dir = path.join(configDir, ENVIRONMENTS_DIRNAME);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const refs = fsRefResolver();
  return Promise.all(files.map(async (file): Promise<EnvironmentEntry> => {
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
      name,
      description: descriptionOf(body),
      body,
      valid: errorCount === 0,
      errorCount,
      origin: await classifyEnvironmentOrigin(name, content),
    };
  }));
}

/** One environment as the editor opens it: raw body (so `file:` refs survive a round trip), hash,
 *  and validation verdict. */
export async function readEnvironmentDetail(name: string, dir: string = ENVIRONMENTS_DIR): Promise<EnvironmentDetail> {
  const entity = readEnvironment(dir, name);
  const { errors, warnings } = validateEnvironment(name, entity.body, fsRefResolver());
  return {
    name,
    description: descriptionOf(entity.body),
    body: entity.body,
    filePath: entity.filePath,
    origin: await classifyEnvironmentOrigin(name, entity.content),
    sha256: entity.sha256,
    errors,
    warnings,
  };
}

export async function handleEnvironmentsList(
  _deps: UiServiceDeps,
  _params: QueryParams<'environments.list'>,
): Promise<EnvironmentEntry[]> {
  return readEnvironmentEntries(CONFIG_DIR);
}

export async function handleEnvironmentsGet(
  _deps: UiServiceDeps,
  params: QueryParams<'environments.get'>,
): Promise<EnvironmentDetail> {
  return readEnvironmentDetail(params.name);
}
