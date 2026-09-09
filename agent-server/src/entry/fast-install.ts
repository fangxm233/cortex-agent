// input:  repo build outputs, repo + installed package manifests
// output: dependency-parity check and staged sync of build outputs into the install root
// pos:    entry/ layer — dev hot-reload fast path that replaces npm pack + install -g
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'fs';
import * as path from 'path';

/**
 * Why this exists: `npm install -g <tgz>` is not an update, it is a replace. npm rm -rf's the
 * whole installed package directory (661MB / ~40k files, most of it the vendored runtime closure)
 * and re-extracts it. That costs ~12 minutes per src edit, and during the window the running
 * server's own install root has no code in it — a PI session spawned mid-install fails to load
 * its --extension files because dist/agent-adapter/pi/*.js momentarily does not exist.
 *
 * A src rebuild only ever changes the compiled output: dist/, web/dist/, defaults/ (14MB).
 * The dependency closure is byte-identical unless the manifest's dependency sets changed. So when
 * the manifests agree, copy the build outputs in directly and skip pack + install entirely.
 */

/** package.json `files` entries this fast path is written against. `bundled-dependencies/` and the
 *  install scripts are deliberately not synced — they only change when dependencies change, which
 *  is exactly when the parity check below sends us down the full install path.
 *
 *  This is compared against the repo manifest on every run: if `files` grows an entry, the fast
 *  path disables itself until someone teaches it how to sync that entry. Fail closed, because the
 *  failure mode of guessing wrong is a silently stale install. */
const EXPECTED_FILES = [
  'dist/',
  'defaults/',
  'web/dist/',
  'bundled-dependencies/',
  'scripts/install-bundled-dependencies.mjs',
  'scripts/postinstall-restart-trigger.mjs',
  'README.md',
];

/** Manifest fields that decide whether the vendored closure on disk is still correct. */
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies'];

export interface SyncTarget {
  /** Label used in logs. */
  name: string;
  source: string;
  destination: string;
}

export interface FastInstallDirs {
  /** The agent-server package inside the source checkout (CORTEX_REPO). */
  repoDir: string;
  /** Monorepo root — the web SPA is built to <monorepoRoot>/web/dist, not into agent-server/. */
  monorepoRoot: string;
  /** The installed package root the running server loads from (INSTALL_ROOT). */
  installRoot: string;
}

export interface FastInstallPlan {
  /** Null when the outputs can be synced; otherwise why the full install must run instead.
   *  A plain field rather than a discriminated union because this package compiles with
   *  `strict: false`, where union narrowing on a literal discriminant is not dependable. */
  blocked: string | null;
  targets: SyncTarget[];
  manifestSource: string;
  manifestDestination: string;
}

function blockedPlan(reason: string): FastInstallPlan {
  return { blocked: reason, targets: [], manifestSource: '', manifestDestination: '' };
}

function readManifest(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Normalized dependency declaration, stable under key ordering. */
export function dependencyFingerprint(manifest: Record<string, unknown>): string {
  return JSON.stringify(
    DEPENDENCY_FIELDS.map((field) => {
      const value = manifest[field];
      if (Array.isArray(value)) return [field, [...value].sort()];
      if (value && typeof value === 'object') {
        return [field, Object.entries(value as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))];
      }
      return [field, null];
    }),
  );
}

/**
 * Node's directory lookup for `name` starting at `from`: the nearest enclosing node_modules holding
 * it. Deliberately not `require.resolve`, which additionally evaluates the package's `exports` map
 * and can refuse a probe for a dependency that is installed and loadable.
 */
function dependencyReachable(from: string, name: string): boolean {
  let directory = from;
  for (;;) {
    if (fs.existsSync(path.join(directory, 'node_modules', name, 'package.json'))) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/**
 * Decide whether the build outputs can be synced in place. Every rejection reason is returned as
 * text so the caller can log why it fell back to the full install rather than silently doing the
 * slow thing forever.
 */
export function planFastInstall(dirs: FastInstallDirs): FastInstallPlan {
  const { repoDir, monorepoRoot, installRoot } = dirs;
  if (!repoDir || !installRoot) return blockedPlan('repo or install root unset');
  if (path.resolve(repoDir) === path.resolve(installRoot)) {
    return blockedPlan('install root is the source checkout');
  }

  const repoManifestPath = path.join(repoDir, 'package.json');
  const installedManifestPath = path.join(installRoot, 'package.json');
  const repoManifest = readManifest(repoManifestPath);
  if (!repoManifest) return blockedPlan(`unreadable manifest: ${repoManifestPath}`);
  const installedManifest = readManifest(installedManifestPath);
  if (!installedManifest) return blockedPlan('no installed manifest — package was never installed');

  const files = Array.isArray(repoManifest.files) ? (repoManifest.files as string[]) : [];
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...EXPECTED_FILES].sort())) {
    return blockedPlan('package.json `files` changed — update EXPECTED_FILES in fast-install.ts');
  }

  if (dependencyFingerprint(repoManifest) !== dependencyFingerprint(installedManifest)) {
    return blockedPlan('dependency closure changed');
  }

  // Dependencies arrive from the installer, never from the tarball extraction alone. If an install
  // died before they landed, copying dist over the result leaves a package that cannot boot —
  // force the full path to rebuild it.
  //
  // The test is not whether a *package-local* node_modules exists: only a tarball that bundles its
  // own closure produces one, and the published package is thin, so its dependencies are hoisted
  // into the installer's tree instead. Ask the question Node will ask at require time.
  const declared = Object.keys((installedManifest.dependencies ?? {}) as Record<string, string>);
  const missing = declared.find((name) => !dependencyReachable(installRoot, name));
  if (missing) return blockedPlan(`installed dependency missing: ${missing}`);

  const candidates: SyncTarget[] = [
    { name: 'dist', source: path.join(repoDir, 'dist'), destination: path.join(installRoot, 'dist') },
    { name: 'defaults', source: path.join(repoDir, 'defaults'), destination: path.join(installRoot, 'defaults') },
    {
      name: 'web/dist',
      source: path.join(monorepoRoot, 'web', 'dist'),
      destination: path.join(installRoot, 'web', 'dist'),
    },
  ];

  const targets = candidates.filter((t) => fs.existsSync(t.source));
  if (!targets.some((t) => t.name === 'dist')) {
    return blockedPlan(`no build output at ${path.join(repoDir, 'dist')}`);
  }

  return { blocked: null, targets, manifestSource: repoManifestPath, manifestDestination: installedManifestPath };
}

/**
 * Replace one directory through a staged rename, mirroring scripts/install-bundled-dependencies.mjs.
 * rename(2) is atomic within a filesystem, so a concurrently spawned process sees either the old
 * tree or the new one — never the half-written state that a plain rm + copy exposes.
 */
export function replaceDirectory(source: string, destination: string): void {
  const suffix = `.cortex-fast-${process.pid}-${Date.now()}`;
  const staged = `${destination}${suffix}.new`;
  const previous = `${destination}${suffix}.old`;
  const hadPrevious = fs.existsSync(destination);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, staged, { recursive: true });
    if (hadPrevious) fs.renameSync(destination, previous);
    fs.renameSync(staged, destination);
    if (hadPrevious) fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    if (hadPrevious && !fs.existsSync(destination) && fs.existsSync(previous)) {
      fs.renameSync(previous, destination);
    }
    throw error;
  }
}

/** Apply a plan. The manifest is copied last so a crash mid-sync leaves the old version string in
 *  place, which keeps the parity check honest on the next attempt. */
export function applyFastInstall(plan: FastInstallPlan): string[] {
  if (plan.blocked) throw new Error(`fast install blocked: ${plan.blocked}`);
  for (const target of plan.targets) replaceDirectory(target.source, target.destination);
  fs.copyFileSync(plan.manifestSource, plan.manifestDestination);
  return plan.targets.map((t) => t.name);
}
