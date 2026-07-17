// input:  relative test module paths
// output: ESM fresh import + root path helpers
// pos:    tests/ shared ESM helper utilities
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SERVER_DIR = path.resolve(TESTS_DIR, '..');

// Re-import ONLY the target module with fresh module state, while its transitive
// imports keep resolving to their existing (shared) singleton instances. This
// matches the original node:test semantics: a unique query string gives the
// target a distinct module id (so Vite re-evaluates it), but deps imported
// without a query stay cached — so a separately static-imported singleton (e.g.
// gateway-manager) remains shared with the fresh graph. `vi.resetModules()`
// would instead reset the WHOLE registry and break that sharing.
async function importFresh(relativePath) {
  const q = `?vfresh=${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return import(/* @vite-ignore */ relativePath + q);
}

function toFileUrl(relativePath) {
  return pathToFileURL(path.resolve(TESTS_DIR, relativePath)).href;
}

export { AGENT_SERVER_DIR, TESTS_DIR, importFresh, toFileUrl };
