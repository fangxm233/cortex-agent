import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { isGitAvailable } from '../../src/core/git-availability.js';

vi.mock('node:fs', () => ({ accessSync: vi.fn(), statSync: vi.fn(), realpathSync: vi.fn(), constants: { X_OK: 1 } }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function environment(platform: string, candidate: string) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
  vi.stubEnv('PATH', '/tools');
  vi.mocked(fs.accessSync).mockImplementation(() => undefined);
  vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats);
  vi.mocked(fs.realpathSync).mockReturnValue(candidate);
  vi.mocked(cp.execFileSync).mockReturnValue('git version 2.50\n');
}

describe('optional Git capability', () => {
  it('does not execute anything when Git is missing', () => {
    environment('linux', '/tools/git');
    vi.mocked(fs.accessSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(isGitAvailable()).toBe(false);
    expect(cp.execFileSync).not.toHaveBeenCalled();
  });
  it.each(['linux', 'win32'])('retains usable Git on %s', platform => {
    environment(platform, '/tools/git');
    expect(isGitAvailable()).toBe(true);
    expect(cp.execFileSync).toHaveBeenCalledWith(expect.any(String), ['--version'], expect.any(Object));
  });
  it('does not execute the macOS shim without developer tools', () => {
    environment('darwin', '/usr/bin/git');
    vi.mocked(cp.execFileSync).mockImplementation(() => { throw new Error('no developer directory'); });
    expect(isGitAvailable()).toBe(false);
    expect(cp.execFileSync).toHaveBeenCalledTimes(1);
    expect(cp.execFileSync).toHaveBeenCalledWith('/usr/bin/xcode-select', ['-p'], expect.any(Object));
  });
  it('uses Apple Git when developer tools are installed', () => {
    environment('darwin', '/usr/bin/git');
    vi.mocked(cp.execFileSync).mockReturnValueOnce('/Library/Developer/CommandLineTools\n');
    expect(isGitAvailable()).toBe(true);
    expect(fs.accessSync).toHaveBeenCalledWith('/Library/Developer/CommandLineTools/usr/bin/git', 1);
  });
  it('uses Homebrew Git without probing developer tools', () => {
    environment('darwin', '/opt/homebrew/bin/git');
    expect(isGitAvailable()).toBe(true);
    expect(cp.execFileSync).toHaveBeenCalledTimes(1);
  });
  it('treats a broken executable as unavailable', () => {
    environment('linux', '/tools/git');
    vi.mocked(cp.execFileSync).mockImplementation(() => { throw new Error('broken'); });
    expect(isGitAvailable()).toBe(false);
  });
});
