import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INSTALL_ROOT } from '@core/paths.js';
import { ownBinDirs } from '../own-bin-path.js';
import { isChanged, type PathChange, type PathRegistrar } from './registrar.js';
import { posixRegistrar } from './posix-profiles.js';
import { windowsRegistrar } from './windows-user-path.js';
import {
  listManagedShims, packageBins, refreshShims, removeShims, renderShims, shimDir, staleShims, writeShims,
  type RenderedShim,
} from './shims.js';

export interface TerminalCliContext {
  home: string;
  node: string;
  installRoot: string;
  platform: NodeJS.Platform;
  pathEnv: string;
  registrar: PathRegistrar;
}

const pathApi = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);
const pathKey = (dir: string, platform: NodeJS.Platform) => {
  const normalized = pathApi(platform).normalize(dir).replace(/[\\/]+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/** Absolute paths of `names` found in `pathEnv`, skipping `excludeDirs`. */
export function findOnPath(names: string[], pathEnv: string, platform: NodeJS.Platform, excludeDirs: string[] = []): string[] {
  const p = pathApi(platform);
  const excluded = new Set(excludeDirs.map((dir) => pathKey(dir, platform)));
  const dirs = pathEnv.split(p.delimiter).filter((dir) => dir && !excluded.has(pathKey(dir, platform)));
  return dirs.flatMap((dir) => names.map((name) => p.join(dir, name))).filter((file) => fs.existsSync(file));
}

function defaultRegistrar(platform: NodeJS.Platform, pathEnv: string): PathRegistrar {
  if (platform === 'win32') return windowsRegistrar();
  return posixRegistrar({
    home: os.homedir(),
    platform,
    zdotdir: process.env.ZDOTDIR,
    exists: fs.existsSync,
    hasZsh: findOnPath(['zsh'], pathEnv, platform).length > 0,
  });
}

export function defaultTerminalCliContext(home: string): TerminalCliContext {
  const platform = process.platform;
  const pathEnv = process.env.PATH ?? '';
  return { home, node: process.execPath, installRoot: INSTALL_ROOT, platform, pathEnv, registrar: defaultRegistrar(platform, pathEnv) };
}

function renderFor(ctx: Pick<TerminalCliContext, 'home' | 'node' | 'installRoot' | 'platform'>): RenderedShim[] {
  return renderShims({ node: ctx.node, home: ctx.home, bins: packageBins(ctx.installRoot) }, ctx.platform);
}

const summarize = (changes: PathChange[]) => changes.map((change) => ({ target: change.target, changed: isChanged(change) }));

/** Another `cortex` that new terminals will no longer reach first. */
function shadowedCortex(ctx: TerminalCliContext, dir: string): string[] {
  const names = ctx.platform === 'win32' ? ['cortex.cmd', 'cortex.exe', 'cortex'] : ['cortex'];
  return findOnPath(names, ctx.pathEnv, ctx.platform, [dir, ...ownBinDirs(ctx.node, ctx.installRoot, ctx.platform)]);
}

export function installTerminalCli(ctx: TerminalCliContext, dryRun: boolean) {
  const dir = shimDir(ctx.home);
  const shims = renderFor(ctx);
  const changes = ctx.registrar.plan(dir, 'add');
  const written = dryRun ? staleShims(dir, shims) : writeShims(dir, shims);
  if (!dryRun) ctx.registrar.apply(changes);
  return {
    ok: true, action: 'install', dry_run: dryRun, dir, shims: shims.map((shim) => shim.file), written,
    path_targets: summarize(changes), shadowed: shadowedCortex(ctx, dir),
  };
}

export function removeTerminalCli(ctx: TerminalCliContext, dryRun: boolean) {
  const dir = shimDir(ctx.home);
  const changes = ctx.registrar.plan(dir, 'remove');
  const removed = dryRun ? listManagedShims(dir) : removeShims(dir);
  if (!dryRun) ctx.registrar.apply(changes);
  return { ok: true, action: 'remove', dry_run: dryRun, dir, removed, path_targets: summarize(changes) };
}

export function terminalCliStatus(ctx: TerminalCliContext) {
  const dir = shimDir(ctx.home);
  const installed = listManagedShims(dir);
  const stale = installed.length > 0 ? staleShims(dir, renderFor(ctx)) : [];
  const registered = ctx.registrar.plan(dir, 'add').map((change) => ({ target: change.target, registered: !isChanged(change) }));
  const onPath = ctx.pathEnv.split(pathApi(ctx.platform).delimiter).some((entry) => entry && pathKey(entry, ctx.platform) === pathKey(dir, ctx.platform));
  return { ok: true, dir, installed: installed.length > 0, shims: installed, stale, path_targets: registered, on_current_path: onPath };
}

/** Daemon start: keep installed shims pointing at the node and entry that are running now. */
export function refreshTerminalCli(home: string): string[] {
  const ctx = { home, node: process.execPath, installRoot: INSTALL_ROOT, platform: process.platform };
  return refreshShims(shimDir(home), renderFor(ctx));
}
