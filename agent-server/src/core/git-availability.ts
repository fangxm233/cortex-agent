import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch { return false; }
}

function gitOnPath(): string | null {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const candidates = (process.env.PATH || '').split(path.delimiter)
    .flatMap(dir => extensions.map(ext => path.resolve(dir, `git${ext}`)));
  return candidates.find(executable) ?? null;
}

function appleGitReady(candidate: string): boolean {
  if (process.platform !== 'darwin' || realpathSync(candidate) !== '/usr/bin/git') return true;
  // xcode-select -p is read-only; executing Apple's git shim can open the CLT installer.
  const developerDir = execFileSync('/usr/bin/xcode-select', ['-p'], {
    encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
  }).trim();
  return !!developerDir && executable(path.join(developerDir, 'usr/bin/git'));
}

/** Optional Git capability, without invoking an unconfigured macOS developer-tools shim. */
export function isGitAvailable(): boolean {
  try {
    const candidate = gitOnPath();
    if (!candidate || !appleGitReady(candidate)) return false;
    const version = execFileSync(candidate, ['--version'], {
      encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
    });
    return version.startsWith('git version ');
  } catch { return false; }
}
