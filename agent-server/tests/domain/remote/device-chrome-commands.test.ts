// input:  device platforms
// output: pinned shell snippets that launch and stop a managed Chrome on a device
// pos:    tests for the device-browser command builders
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  chromeCandidates, chromeLaunchCommand, chromeStopCommand, DEVICE_PROFILE_PATH,
} from '@domain/remote/device-chrome-commands.js';

describe('chromeLaunchCommand', () => {
  const win = chromeLaunchCommand('win32');
  const linux = chromeLaunchCommand('linux');

  it('asks Chrome to pick the port and reads it back from the file Chrome writes', () => {
    // Port 0 means we never have to guess a free port on a machine we do not own, and waiting on
    // DevToolsActivePort means the device needs no HTTP client to prove Chrome came up.
    expect(win).toContain('--remote-debugging-port=0');
    expect(win).toContain('DevToolsActivePort');
    expect(win).toContain('Get-Content -LiteralPath $portFile -TotalCount 1');
    expect(linux).toContain('head -1 "$PORTFILE"');
  });

  it('keeps the debugging port on loopback', () => {
    // It is an unauthenticated remote-control port; the reverse channel is what carries it off the
    // machine, not the network.
    for (const cmd of [win, linux]) expect(cmd).toContain('--remote-debugging-address=127.0.0.1');
  });

  it('uses a private profile, which Chrome 136+ requires for remote debugging', () => {
    expect(win).toContain(`.cortex\\browser\\profile`);
    expect(win).toContain('--user-data-dir=$quote$profile$quote');
    expect(linux).toContain(`--user-data-dir="$PROFILE"`);
    expect(linux).toContain(`PROFILE="$HOME/${DEVICE_PROFILE_PATH}"`);
  });

  it('adopts an existing browser before launching another', () => {
    // A device Chrome outlives one turn on purpose — that is what lets a human log in once.
    expect(win).toContain('Get-Content -LiteralPath $portFile -TotalCount 1');
    expect(linux).toContain('if [ -s "$PORTFILE" ]; then head -1 "$PORTFILE"; exit 0; fi');
  });

  it('launches Windows Chrome through an interactive scheduled task', () => {
    expect(win).toContain('New-ScheduledTaskPrincipal');
    expect(win).toContain('-LogonType Interactive');
    expect(win).toContain('Register-ScheduledTask');
    expect(win).toContain('Start-ScheduledTask');
    expect(win).toContain('</dev/null');
    expect(win).not.toContain('nohup "$CHROME"');
    expect(win).not.toContain('--headless');
    expect(win).not.toContain('CORTEX_CLIENT_TOKEN');
  });

  it('fails explicitly when no matching desktop user is active', () => {
    expect(win).toContain('no-interactive-user');
    expect(win).toContain('interactive-user-mismatch');
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

  it('stops the Windows task and swallows already-dead process errors', () => {
    // Killing the browser process takes the renderers with it, so the rest of the enumeration is
    // already stale by the time the loop reaches it.
    const win = chromeStopCommand('win32');
    expect(win).toContain('Stop-ScheduledTask');
    expect(win).toContain('-ErrorAction SilentlyContinue');
    expect(win).toContain('</dev/null');
  });

  it('always clears the port file, so the next launch cannot adopt a dead browser', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(chromeStopCommand(platform)).toContain('rm -f');
      expect(chromeStopCommand(platform)).toContain('DevToolsActivePort');
    }
  });
});

describe('chromeCandidates', () => {
  it('knows the fixed install locations per platform', () => {
    expect(chromeCandidates('win32').some((p) => p.includes('chrome.exe'))).toBe(true);
    expect(chromeCandidates('darwin')[0]).toContain('Google Chrome.app');
    expect(chromeCandidates('linux')).toEqual([]);
  });
});
