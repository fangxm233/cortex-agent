import * as path from 'path';
import { INSTALL_ROOT } from '@core/paths.js';
import { npmPrefixFromInstallRoot } from '@core/utils.js';

const SERVER_PACKAGE = '@cortex-agent/server';

/**
 * Directories that hold this server's own `node` and npm-linked bins (`cortex`, `cortex-signal`).
 * The npm bin dir is absent for a repo checkout, which has no global prefix.
 */
export function ownBinDirs(
  execPath: string = process.execPath,
  installRoot: string = INSTALL_ROOT,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = [p.dirname(execPath)];
  const prefix = npmPrefixFromInstallRoot(installRoot, SERVER_PACKAGE, platform);
  if (prefix) dirs.push(platform === 'win32' ? prefix : p.join(prefix, 'bin'));
  return dirs;
}

/** Prepend each dir missing from `pathEnv`; entries already present keep their position. */
export function withDirsOnPath(pathEnv: string, dirs: string[], platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const key = (dir: string) => {
    const normalized = p.normalize(dir).replace(/[\\/]+$/, '');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const entries = pathEnv.split(p.delimiter).filter(Boolean);
  const present = new Set(entries.map(key));
  const missing = dirs.filter((dir) => !present.has(key(dir)));
  return [...missing, ...entries].join(p.delimiter);
}

/**
 * Sessions inherit this process's env, and skills, waitpoint recipes and Claude hooks call bare
 * `cortex`, `cortex-signal` and `node`. Make them resolve to this install however the daemon was
 * started (desktop app, init-written service unit, terminal restart).
 */
export function ensureOwnBinsOnPath(): void {
  process.env.PATH = withDirsOnPath(process.env.PATH ?? '', ownBinDirs());
}
