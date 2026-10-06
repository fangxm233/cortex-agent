import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as clack from '@clack/prompts';
import { isGitAvailable } from '@core/git-availability.js';
import { t } from '@core/i18n.js';

export const isGitInstalled = isGitAvailable;

export function getGitInstallHint(): string {
  if (process.platform === 'win32') return 'winget install --id Git.Git -e --source winget';
  if (process.platform === 'darwin') return 'xcode-select --install  (or  brew install git  if you use Homebrew)';
  return 'Install Git via your package manager or https://git-scm.com/downloads';
}

function installWindowsGit(): boolean {
  const s = clack.spinner();
  s.start(t('init.git.autoInstalling'));
  try {
    execSync('winget install --id Git.Git -e --source winget --silent', { stdio: 'pipe', timeout: 120_000 });
    s.stop(t('init.git.installed'));
    if (isGitInstalled()) return true;
    clack.log.warn(t('init.git.notOnPath'));
  } catch (err: unknown) {
    s.stop(t('init.git.autoInstallFailed'));
    clack.log.warn(err instanceof Error ? err.message : String(err));
  }
  clack.log.info(t('init.git.manualHint', { hint: getGitInstallHint() }));
  return false;
}

/** Only Windows needs Git Bash for shell tools; POSIX setup never installs optional Git. */
export function ensureGitInstalled(): boolean {
  if (isGitInstalled()) return true;
  if (process.platform !== 'win32') {
    clack.log.info(t('init.git.optional'));
    return false;
  }
  clack.log.warn(t('init.git.required'));
  return installWindowsGit();
}

export function ensureGitRepo(dataDir: string): void {
  if (existsSync(path.join(dataDir, '.git'))) return;
  try {
    execSync('git init', { cwd: dataDir, stdio: 'pipe' });
  } catch (err: unknown) {
    clack.log.warn(t('init.git.initFailed', { message: err instanceof Error ? err.message : String(err) }));
  }
}
