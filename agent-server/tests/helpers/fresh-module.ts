// Two ways to get a module with fresh state, and they are not interchangeable:
//
//   importFresh             re-evaluates ONLY the target. A unique query string gives it a module id
//                           of its own, while everything it imports stays the shared, already-loaded
//                           instance — so a singleton the test imported statically (e.g.
//                           gateway-manager) is the same object the fresh module talks to.
//   importWithFreshRegistry throws the whole module registry away first. Use it when the state to
//                           reset lives in a transitive import (config.ts caches, paths.ts constants)
//                           or when vi.doMock must reach every module in the graph.
import { vi } from 'vitest';

/** Re-import `url` (built against the caller: `new URL('../src/x.js', import.meta.url)`) with
 *  fresh module state, keeping its imports shared. */
export function importFresh<T = any>(url: URL): Promise<T> {
  const fresh = new URL(url);
  fresh.searchParams.set('vfresh', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return import(/* @vite-ignore */ fresh.href) as Promise<T>;
}

/** importFresh, plus the module's `_testReset()` registered on the test. A module that owns a
 *  timer, interval or listener must be reset even when an assertion throws first; a reset written
 *  as the last line of the test body is skipped then, and the leaked handle hangs the run. */
export async function importFreshWithReset<T extends { _testReset(): unknown }>(
  t: { onTestFinished: (fn: () => unknown) => void },
  url: URL,
): Promise<T> {
  const mod = await importFresh<T>(url);
  t.onTestFinished(() => mod._testReset());
  return mod;
}

/** Reset the whole module registry, then run `load` (an `import()` written at the call site, so it
 *  resolves against the caller). */
export function importWithFreshRegistry<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  return load();
}
