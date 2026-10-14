
import { existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

function hasRepository(cwd) {
  let dir = resolve(cwd);
  while (!existsSync(join(dir, '.git'))) {
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return true;
}

function appleGitReady() {
  if (process.platform !== 'darwin') return true;
  const git = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (realpathSync(git) !== '/usr/bin/git') return true;
  const developerDir = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  return !!developerDir && existsSync(join(developerDir, 'usr/bin/git'));
}

/** null means history is unavailable; do not launch Apple's developer-tools installer. */
export function gitStatus(cwd = process.cwd()) {
  if (!hasRepository(cwd)) return null;
  try {
    if (!appleGitReady()) return null;
    return execFileSync('git', ['status', '--porcelain'], {
      cwd, encoding: 'utf8', stdio: 'pipe', timeout: 10_000,
    }).trim();
  } catch { return null; }
}
