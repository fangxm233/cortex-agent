import { afterEach, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { isGitAvailable } from '../../src/core/git-availability.js';
import { ensureGitInstalled, ensureGitRepo } from '../../src/entry/init-git.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
vi.mock('../../src/core/git-availability.js', () => ({ isGitAvailable: vi.fn() }));
vi.mock('@clack/prompts', () => ({ log: { info: vi.fn(), warn: vi.fn() }, spinner: () => ({ start: vi.fn(), stop: vi.fn() }) }));
afterEach(() => vi.restoreAllMocks());

it.each(['darwin', 'linux'])('never installs unavailable Git on %s', platform => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
  vi.mocked(isGitAvailable).mockReturnValue(false);
  expect(ensureGitInstalled()).toBe(false);
  expect(execSync).not.toHaveBeenCalled();
});

it('keeps Windows automatic Git installation', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.mocked(isGitAvailable).mockReturnValueOnce(false).mockReturnValueOnce(true);
  expect(ensureGitInstalled()).toBe(true);
  expect(execSync).toHaveBeenCalledWith('winget install --id Git.Git -e --source winget --silent', expect.any(Object));
});

it('retains repository initialization when Git is available', () => {
  vi.mocked(isGitAvailable).mockReturnValue(true);
  expect(ensureGitInstalled()).toBe(true);
  ensureGitRepo('/nonexistent-git-optional-test');
  expect(execSync).toHaveBeenCalledWith('git init', { cwd: '/nonexistent-git-optional-test', stdio: 'pipe' });
});
