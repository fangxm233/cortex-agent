import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { decideDisplay, pickFreeDisplay, type DisplayProbe } from '@platform/browser/display.js';
import { resolveChromeBinary, backendSupportsBrowser } from '@platform/browser/managed-browser.js';

const base: DisplayProbe = {
  platform: 'linux',
  usableDisplays: [],
  hasXvfb: false,
  interactiveSession: false,
};

describe('decideDisplay: linux', () => {
  it('uses $DISPLAY when the probe reached it', () => {
    const d = decideDisplay({ ...base, envDisplay: ':10', usableDisplays: [':10', ':20'] });
    expect(d.mode).toBe('attached');
    expect(d.display).toBe(':10');
    expect(d.takeover).toBe('remote-desktop');
  });

  it('ignores a stale $DISPLAY that the probe could not reach', () => {
    // A service inherits DISPLAY=:0 constantly; launching Chrome there would just fail.
    const d = decideDisplay({ ...base, envDisplay: ':0', usableDisplays: [':10'] });
    expect(d.display).toBe(':10');
  });

  it('falls back to the lowest reachable owned display', () => {
    const d = decideDisplay({ ...base, usableDisplays: [':10', ':2'] });
    // The probe sorts; decide must not reorder it.
    expect(d.display).toBe(':10');
    expect(d.mode).toBe('attached');
  });

  it('prefers a virtual display over headless when Xvfb exists', () => {
    const d = decideDisplay({ ...base, hasXvfb: true });
    expect(d.mode).toBe('virtual');
    expect(d.display).toBeNull(); // assigned at Xvfb start
    expect(d.takeover).toBe('vnc-required');
  });

  it('degrades to headless rather than failing when nothing graphical exists', () => {
    const d = decideDisplay(base);
    expect(d.mode).toBe('headless');
    expect(d.takeover).toBe('none');
  });
});

describe('decideDisplay: macOS and Windows', () => {
  it('attaches inside an interactive session', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const d = decideDisplay({ ...base, platform, interactiveSession: true });
      expect(d.mode).toBe('attached');
      expect(d.display).toBeNull(); // no DISPLAY concept on these platforms
      expect(d.takeover).toBe('remote-desktop');
    }
  });

  it('reports headless for Windows Session 0, where a window can never be seen', () => {
    const d = decideDisplay({ ...base, platform: 'win32', interactiveSession: false });
    expect(d.mode).toBe('headless');
    expect(d.takeover).toBe('none');
    expect(d.reason).toMatch(/Session 0/);
  });

  it('reports headless for a macOS daemon context', () => {
    const d = decideDisplay({ ...base, platform: 'darwin', interactiveSession: false });
    expect(d.mode).toBe('headless');
  });

  it('never claims a linux X display on a non-linux platform', () => {
    const d = decideDisplay({ ...base, platform: 'darwin', usableDisplays: [':10'], interactiveSession: true });
    expect(d.display).toBeNull();
  });
});

describe('decideDisplay: override', () => {
  it('trusts an operator override on any platform', () => {
    const d = decideDisplay({ ...base, override: ':77', usableDisplays: [':10'] });
    expect(d.display).toBe(':77');
    expect(d.mode).toBe('attached');
  });
});

describe('resolveChromeBinary', () => {
  it('rejects an override that does not exist rather than spawning a bogus path', async () => {
    expect(await resolveChromeBinary({ CORTEX_BROWSER_BINARY: '/nonexistent/chrome' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('probes PATH without stalling the event loop', async () => {
    // These probes run inside the daemon; a synchronous one freezes every session until it returns.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-which-'));
    fs.writeFileSync(path.join(bin, 'which'), '#!/bin/sh\nsleep 0.2\nexit 1\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      expect(await resolveChromeBinary({} as NodeJS.ProcessEnv)).toBeNull();
    } finally {
      clearInterval(timer);
      process.env.PATH = savedPath;
    }
    expect(ticks).toBeGreaterThan(5);
  });
});

describe('pickFreeDisplay', () => {
  it('skips numbers held by a lock file or a socket, whoever owns them', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xdisp-'));
    fs.mkdirSync(path.join(tmp, '.X11-unix'));
    fs.writeFileSync(path.join(tmp, '.X99-lock'), '');
    fs.writeFileSync(path.join(tmp, '.X11-unix', 'X100'), '');
    expect(pickFreeDisplay(99, tmp)).toBe(101);
    expect(pickFreeDisplay(102, tmp)).toBe(102);
  });
});

describe('backendSupportsBrowser', () => {
  it('accepts every spawn path that composes the browser MCP server', () => {
    // Claude print and TUI both append a --mcp-config file; PI writes the same descriptor into the
    // envelope its MCP bridge reads.
    expect(backendSupportsBrowser('claude')).toBe(true);
    expect(backendSupportsBrowser('pi')).toBe(true);
  });

  it('still refuses a backend nobody has wired', () => {
    // Starting Chrome for a backend that cannot drive it burns a browser nobody can use, so this
    // stays a check rather than becoming `true`.
    expect(backendSupportsBrowser('codex')).toBe(false);
    expect(backendSupportsBrowser('')).toBe(false);
  });
});
