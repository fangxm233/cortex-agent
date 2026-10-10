import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { isGitAvailable } from '../../src/core/git-availability.js';
import { ensureGitInstalled, ensureGitRepo, getGitInstallHint } from '../../src/entry/init-git.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
vi.mock('../../src/core/git-availability.js', () => ({ isGitAvailable: vi.fn() }));
vi.mock('@clack/prompts', () => ({ log: { info: vi.fn(), warn: vi.fn() }, spinner: () => ({ start: vi.fn(), stop: vi.fn() }) }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

it.each(['darwin', 'linux'])('never installs unavailable Git on %s', platform => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
  vi.mocked(isGitAvailable).mockReturnValue(false);
  expect(ensureGitInstalled()).toBe(false);
  expect(execSync).not.toHaveBeenCalled();
});

it('only checks unavailable Windows Git and never invokes an installer', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.mocked(isGitAvailable).mockReturnValue(false);
  expect(ensureGitInstalled()).toBe(false);
  expect(isGitAvailable).toHaveBeenCalledTimes(1);
  expect(execSync).not.toHaveBeenCalled();
});

it('accepts already prepared Windows Git without any installation', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.mocked(isGitAvailable).mockReturnValue(true);
  expect(ensureGitInstalled()).toBe(true);
  expect(isGitAvailable).toHaveBeenCalledTimes(1);
  expect(execSync).not.toHaveBeenCalled();
});

it('does not prescribe winget for missing Windows Git Bash', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  expect(getGitInstallHint()).toContain('https://git-scm.com/download/win');
  expect(getGitInstallHint()).toContain('Git Bash');
  expect(getGitInstallHint()).not.toMatch(/winget|powershell/i);
});

it('retains repository initialization when Git is available', () => {
  vi.mocked(isGitAvailable).mockReturnValue(true);
  expect(ensureGitInstalled()).toBe(true);
  ensureGitRepo('/nonexistent-git-optional-test');
  expect(execSync).toHaveBeenCalledWith('git init', { cwd: '/nonexistent-git-optional-test', stdio: 'pipe' });
});
