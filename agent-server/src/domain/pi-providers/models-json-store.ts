// input:  a PI models.json path and provider entries
// output: merge-preserving reads, writes and removals of provider blocks
// pos:    Persistence of PI's user-owned provider catalog
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'fs';
import * as path from 'path';

import { createLogger } from '@core/log.js';

// The catalog file format is the PI adapter's to know: it is the same file the adapter mirrors into
// the per-spawn catalog, so both sides must agree on what counts as a user-defined provider.
export {
  isCustomProviderEntry,
  readCustomProviderEntries,
  readProvidersBlock,
} from '../../agent-adapter/pi/custom-catalog.js';
export { USER_PI_MODELS_PATH } from '../../agent-adapter/pi/agent-dir.js';

const log = createLogger('pi-custom-providers');

type Document = Record<string, unknown>;

function readDocument(modelsPath: string): Document {
  if (!existsSync(modelsPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(modelsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Document;
  } catch (err) {
    log.warn(`Unreadable PI models.json at ${modelsPath}: ${(err as Error).message}`);
    return {};
  }
}

function providersOf(doc: Document): Record<string, unknown> {
  const providers = doc.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {};
  return providers as Record<string, unknown>;
}

/**
 * Replace the file with `doc`, keeping the previous content as `<path>.bak`. Written through a
 * temp file + rename so a crash mid-write cannot leave PI with a truncated catalog.
 */
function writeDocument(modelsPath: string, doc: Document): void {
  mkdirSync(path.dirname(modelsPath), { recursive: true });
  if (existsSync(modelsPath)) {
    try {
      copyFileSync(modelsPath, `${modelsPath}.bak`);
    } catch (err) {
      log.warn(`Failed to back up ${modelsPath}: ${(err as Error).message}`);
    }
  }
  const tmp = `${modelsPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(tmp, modelsPath);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Write one provider block, replacing it wholesale and leaving every other key untouched. */
export function upsertModelsJsonProvider(
  modelsPath: string,
  name: string,
  entry: Record<string, unknown>,
): void {
  const doc = readDocument(modelsPath);
  const providers = { ...providersOf(doc) };
  providers[name] = entry;
  writeDocument(modelsPath, { ...doc, providers });
}

/** Remove one provider block. Returns false when the name was not present. */
export function removeModelsJsonProvider(modelsPath: string, name: string): boolean {
  const doc = readDocument(modelsPath);
  const providers = { ...providersOf(doc) };
  if (!(name in providers)) return false;
  delete providers[name];
  writeDocument(modelsPath, { ...doc, providers });
  return true;
}
