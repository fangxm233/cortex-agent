// input:  device platforms
// output: pinned shell snippets that launch and stop a managed Chrome on a device
// pos:    tests for the device-browser command builders
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  chromeCandidates, chromeLaunchCommand, chromeResetPortFileCommand, chromeStopCommand,
  DEVICE_PROFILE_PATH,
} from '@domain/remote/device-chrome-commands.js';

describe('chromeLaunchCommand', () => {
  const win = chromeLaunchCommand('win32');
  const linux = chromeLaunchCommand('linux');

  it('asks Chrome to pick the port and reads it back from the file Chrome writes', () => {
    // Port 0 means we never have to guess a free port on a machine we do not own, and waiting on
    // DevToolsActivePort means the device needs no HTTP client to prove Chrome came up.
    expect(win).toContain('--remote-debugging-port=0');
    expect(win).toContain('DevToolsActivePort');
    expect(win).toContain('head -1 "$PORTFILE"');
  });

  it('keeps the debugging port on loopback', () => {
    // It is an unauthenticated remote-control port; the reverse channel is what carries it off the
    // machine, not the network.
    for (const cmd of [win, linux]) expect(cmd).toContain('--remote-debugging-address=127.0.0.1');
  });

  it('uses a private profile, which Chrome 136+ requires for remote debugging', () => {
    for (const cmd of [win, linux]) {
      expect(cmd).toContain(`--user-data-dir="$PROFILE"`);
      expect(cmd).toContain(`PROFILE="$HOME/${DEVICE_PROFILE_PATH}"`);
    }
  });

  it('adopts an existing browser before launching another', () => {
    // A device Chrome outlives one turn on purpose — that is what lets a human log in once.
    expect(win).toContain('if [ -s "$PORTFILE" ]; then head -1 "$PORTFILE"; exit 0; fi');
  });

  it('reaches ProgramFiles(x86) through printenv, since bash cannot name it', () => {
    // `${PROGRAMFILES(X86)}` is a bash syntax error: parentheses are not allowed inside ${...}.
    expect(win).toContain(`printenv 'ProgramFiles(x86)'`);
    expect(win).not.toContain('${PROGRAMFILES(X86)}');
  });

  it('sets no `set -u`, which would abort on any unset Windows variable', () => {
    expect(win.split('\n')[0]).not.toBe('set -u');
  });

  it('falls back to PATH lookups where there is no fixed install location', () => {
    expect(chromeCandidates('linux')).toEqual([]);
    expect(linux).toContain('command -v "$b"');
    expect(linux).toContain('google-chrome');
  });

  it('fails loudly when there is no Chrome at all', () => {
    expect(linux).toContain('chrome-not-found');
    expect(linux).toContain('chrome-did-not-listen');
  });
});

describe('chromeStopCommand', () => {
  it('matches on the profile path rather than a pid', () => {
    // git-bash reports its own MSYS pid for a Windows child, and Chrome re-parents itself anyway.
    // The profile path is unique to us, so it can never hit the browser the human is using.
    expect(chromeStopCommand('linux')).toContain(`pkill -f -- "$HOME/${DEVICE_PROFILE_PATH}"`);
    expect(chromeStopCommand('win32')).toContain('Stop-Process');
    expect(chromeStopCommand('win32')).toContain('.cortex*browser*profile');
  });

  it('swallows its own errors on Windows', () => {
    // Killing the browser process takes the renderers with it, so the rest of the enumeration is
    // already stale by the time the loop reaches it.
    expect(chromeStopCommand('win32')).toContain('-ErrorAction SilentlyContinue');
  });

  it('always clears the port file, so the next launch cannot adopt a dead browser', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(chromeStopCommand(platform)).toContain('rm -f');
      expect(chromeStopCommand(platform)).toContain('DevToolsActivePort');
    }
    expect(chromeResetPortFileCommand()).toContain('DevToolsActivePort');
  });
});

describe('chromeCandidates', () => {
  it('knows the fixed install locations per platform', () => {
    expect(chromeCandidates('win32').some((p) => p.includes('chrome.exe'))).toBe(true);
    expect(chromeCandidates('darwin')[0]).toContain('Google Chrome.app');
    expect(chromeCandidates('linux')).toEqual([]);
  });
});
