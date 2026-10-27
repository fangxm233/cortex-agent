import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { finishRebuildStep, startRebuildStep } from '@core/rebuild-progress.js';
import { withServerNpmPrefix } from '@core/utils.js';
import { applyFastInstall, planFastInstall } from './fast-install.js';
import {
  applyBundleInstall, copyBundleSourceMaps, planBundleInstall, validateBundleStage,
} from './bundle-install.js';
import { runBuildSteps, type RebuildBuildOptions } from './source-rebuild-build.js';

export interface SourceRebuildOptions extends RebuildBuildOptions {
  installRoot: string;
  /** Captured by the daemon at startup; CORTEX_REBUILD_BUNDLE=0 is the source rollback. */
  bundle: boolean;
  /** Second idle gate: called after staging, before any installed files are touched. */
  deferInstall(): boolean;
  restart(): Promise<void>;
}

type InstallMode = 'bundle-fast' | 'bundle-full' | 'source';
type RebuildOutcome = 'finished' | 'deferred';

/** Pure policy; validation and dependency/layout comparison belong to the installers. */
export function selectRebuildInstallPlan(p: { bundle: boolean; bundleBlocked: string | null }): InstallMode {
  if (!p.bundle) return 'source';
  return p.bundleBlocked === null ? 'bundle-fast' : 'bundle-full';
}

class RebuildFailure extends Error {
  constructor(readonly step: string, detail: string) { super(detail); }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** No bundle failure falls back to source. The caller owns serialization and queued-trigger state. */
export async function runSourceRebuild(options: SourceRebuildOptions): Promise<RebuildOutcome> {
  try {
    if (!await runBuildSteps(options)) return 'finished';
    return await withRebuildStage(options);
  } catch (error) {
    const step = error instanceof RebuildFailure ? error.step : 'install';
    options.abort(step, errorDetail(error));
    return 'finished';
  }
}

async function withRebuildStage(options: SourceRebuildOptions): Promise<RebuildOutcome> {
  const ownedRoot = options.bundle ? mkdtempSync(path.join(tmpdir(), 'cortex-rebuild-')) : null;
  try {
    return await finishSourceRebuild(options, ownedRoot ? path.join(ownedRoot, 'stage') : null);
  } finally {
    // Only remove the root allocated by this invocation, including on errors and idle deferral.
    if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
  }
}

async function finishSourceRebuild(options: SourceRebuildOptions, stageDir: string | null): Promise<RebuildOutcome> {
  if (stageDir) await buildBundleStage(options, stageDir);
  if (options.deferInstall()) return 'deferred';
  options.update(progress => startRebuildStep(progress, 'install'));
  const detail = await installRebuild(options, stageDir);
  options.update(progress => finishRebuildStep(progress, 'install', 'done', detail));
  options.log.info('Rebuild succeeded — restarting app.ts');
  await options.restart();
  return 'finished';
}

async function buildBundleStage(options: SourceRebuildOptions, stageDir: string): Promise<void> {
  options.update(progress => startRebuildStep(progress, 'bundle'));
  try {
    await runChecked(options, 'bundle', process.execPath,
      ['scripts/bundle.mjs', stageDir, '--sourcemap'], options.dirs.repoDir);
    validateBundleStage(stageDir);
    options.update(progress => finishRebuildStep(progress, 'bundle', 'done'));
  } catch (error) {
    throw new RebuildFailure('bundle', errorDetail(error));
  }
}

async function installRebuild(options: SourceRebuildOptions, stageDir: string | null): Promise<string> {
  if (!stageDir) return installSource(options);
  const plan = planBundleInstall({ stageDir, installRoot: options.installRoot });
  const mode = selectRebuildInstallPlan({ bundle: options.bundle, bundleBlocked: plan.blocked });
  if (mode === 'bundle-fast') {
    const synced = applyBundleInstall(plan);
    options.log.info(`Bundle fast install: ${synced.join(', ')}`);
    return mode;
  }
  options.log.info(`Bundle fast install unavailable (${plan.blocked}) — packing staged bundle`);
  const tarball = await packBundle(options, stageDir);
  await installTarball(options, tarball);
  // npm excludes local maps; keep the stage until they are restored and restart has been requested.
  copyBundleSourceMaps(stageDir, options.installRoot);
  return 'bundle-full';
}

/** Preserve the old source planner and its recoverable fast-sync → full-install behavior. */
function trySourceFastInstall(options: SourceRebuildOptions): string[] | null {
  const plan = planFastInstall({
    repoDir: options.dirs.repoDir,
    monorepoRoot: path.dirname(options.dirs.repoDir),
    installRoot: options.installRoot,
  });
  if (plan.blocked) {
    options.log.info(`Fast install unavailable (${plan.blocked}) — falling back to pack + install -g`);
    return null;
  }
  try {
    return applyFastInstall(plan);
  } catch (error) {
    options.log.warn(`Fast install failed (${errorDetail(error)}) — falling back to pack + install -g`);
    return null;
  }
}

async function installSource(options: SourceRebuildOptions): Promise<string> {
  const synced = trySourceFastInstall(options);
  if (synced) {
    options.log.info(`Fast install: ${synced.join(', ')}`);
    return 'fast';
  }
  await runChecked(options, 'tgz cleanup', 'bash', ['-c', 'rm -f cortex-agent-server-*.tgz'], options.dirs.repoDir);
  // Source rollback intentionally retains npm pack's prepare/prepack lifecycle builds.
  await runChecked(options, 'pack', 'npm', ['pack'], options.dirs.repoDir);
  await installTarball(options, findNewestTarball(options.dirs.repoDir));
  return 'pack + install -g';
}

async function packBundle(options: SourceRebuildOptions, stageDir: string): Promise<string> {
  await runChecked(options, 'pack', 'npm', ['pack', '--ignore-scripts'], stageDir);
  return findNewestTarball(stageDir);
}

function findNewestTarball(directory: string): string {
  const candidates = readdirSync(directory)
    .filter(file => file.startsWith('cortex-agent-server-') && file.endsWith('.tgz'))
    .map(file => ({ file, mtime: statSync(path.join(directory, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new RebuildFailure('pack', 'npm pack succeeded but no cortex-agent-server-*.tgz found');
  return path.join(directory, candidates[0].file);
}

async function installTarball(options: SourceRebuildOptions, tarball: string): Promise<void> {
  options.log.info(`Packed tarball: ${tarball}`);
  const args = withServerNpmPrefix(['install', '-g', tarball], options.installRoot);
  // Only the daemon's install suppresses the hook: the pipeline itself restarts immediately.
  const env = { ...process.env, CORTEX_SKIP_POSTINSTALL_RESTART: '1' };
  const code = await options.run('npm', args, { cwd: tmpdir(), env });
  if (code !== 0) throw new RebuildFailure('install', `exit ${code}`);
}

async function runChecked(
  options: SourceRebuildOptions, step: string, cmd: string, args: string[], cwd: string,
): Promise<void> {
  const code = await options.run(cmd, args, { cwd });
  if (code !== 0) throw new RebuildFailure(step, `exit ${code}`);
}
