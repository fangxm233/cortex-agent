import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as clack from '@clack/prompts';
import { isGitAvailable } from '@core/git-availability.js';
import { t } from '@core/i18n.js';

export const isGitInstalled = isGitAvailable;

export function getGitInstallHint(): string {
  if (process.platform === 'win32') return 'https://git-scm.com/download/win (Git for Windows, including Git Bash)';
  if (process.platform === 'darwin') return 'xcode-select --install  (or  brew install git  if you use Homebrew)';
  return 'Install Git via your package manager or https://git-scm.com/downloads';
}

/** Read-only qualification: App setup prepares Windows Git Bash; POSIX Git stays optional. */
export function ensureGitInstalled(): boolean {
  if (isGitInstalled()) return true;
  if (process.platform !== 'win32') {
    clack.log.info(t('init.git.optional'));
    return false;
  }
  clack.log.warn(t('init.git.required'));
  clack.log.info(t('init.git.manualHint', { hint: getGitInstallHint() }));
  return false;
}

export function ensureGitRepo(dataDir: string): void {
  if (existsSync(path.join(dataDir, '.git'))) return;
  try {
    execSync('git init', { cwd: dataDir, stdio: 'pipe' });
  } catch (err: unknown) {
    clack.log.warn(t('init.git.initFailed', { message: err instanceof Error ? err.message : String(err) }));
  }
}
