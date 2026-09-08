// input:  native setup adapter and fake Tauri globals
// output: native install guard and fixed-command regressions
// pos:    Local-only Claude installation boundary tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { afterEach, expect, it, vi } from 'vitest';
import { canSetupClaude, setupClaude, claudeInstallLine } from './setup-native';
afterEach(() => vi.unstubAllGlobals());
it('only accepts bounded Claude install log lines', () => {
  expect(claudeInstallLine({ run: 'start', line: 'ignore' })).toBeNull();
  expect(claudeInstallLine({ run: 'claude-install', line: 'installing' })).toBe('installing');
  expect(claudeInstallLine(null)).toBeNull();
});
it('rejects browser and remote installation without invoking', async () => {
  const invoke = vi.fn();
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  expect(canSetupClaude()).toBe(false);
  vi.stubGlobal('__CORTEX_DESKTOP__', true);
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://remote.example', token: 'test' });
  expect(canSetupClaude()).toBe(false);
  await expect(setupClaude(true)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
it('invokes only fixed no-argument commands and rejects invalid results', async () => {
  const invoke = vi.fn().mockResolvedValue({ installed: true, version: '2' });
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  vi.stubGlobal('__CORTEX_DESKTOP__', true);
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'http://127.0.0.1:9000', token: 'test' });
  expect(canSetupClaude()).toBe(true);
  await setupClaude(false); await setupClaude(true);
  expect(invoke.mock.calls).toEqual([['setup_claude_status', undefined], ['setup_install_claude', undefined]]);
  invoke.mockResolvedValue({});
  await expect(setupClaude(false)).rejects.toThrow();
  invoke.mockRejectedValue(new Error('native guard'));
  await expect(setupClaude(true)).rejects.toThrow('native guard');
});
