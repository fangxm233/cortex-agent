// input:  synthetic probe results for each platform
// output: pinned display-resolution policy for the managed browser
// pos:    tests for managed-browser display selection
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import { decideDisplay, type DisplayProbe } from '@platform/browser/display.js';
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
  it('rejects an override that does not exist rather than spawning a bogus path', () => {
    expect(resolveChromeBinary({ CORTEX_BROWSER_BINARY: '/nonexistent/chrome' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('backendSupportsBrowser', () => {
  it('accepts the Claude print adapter, the only one that composes the browser MCP config', () => {
    expect(backendSupportsBrowser('claude', 'print')).toBe(true);
    expect(backendSupportsBrowser('claude', null)).toBe(true);
  });

  it('refuses PI, whose MCP bridge never sees the endpoint', () => {
    // Starting Chrome here would burn a browser nobody can drive — worse than not starting it.
    expect(backendSupportsBrowser('pi')).toBe(false);
  });

  it('refuses the Claude TUI adapter, which builds its args separately', () => {
    expect(backendSupportsBrowser('claude', 'tui')).toBe(false);
  });
});
