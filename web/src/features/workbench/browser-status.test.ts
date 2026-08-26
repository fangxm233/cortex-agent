// input:  browser status and turn-start payloads
// output: takeover sentences and startup-window regressions
// pos:    Unit tests for browser status reporting
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, expect, it } from 'vitest';
import { browserStartupHint, browserStartupPending, takeoverHint, type BrowserStatus } from './browser-status';

const T = {
  attached: 'desktop{where} — connect to take over',
  virtual: 'virtual display — VNC needed',
  headless: 'headless — no takeover',
  running: 'running',
  stopped: 'starts on demand',
};

function status(over: Partial<BrowserStatus['display']> & { running?: boolean }): BrowserStatus {
  const { running = false, ...display } = over;
  return {
    running, refs: 0, cdpEndpoint: null,
    display: { mode: 'attached', display: ':10', takeover: 'remote-desktop', reason: '', ...display },
  };
}

describe('takeoverHint', () => {
  it('names the display so the user knows which desktop to connect to', () => {
    expect(takeoverHint(status({ running: true }), T)).toBe('running · desktop (:10) — connect to take over');
  });

  it('reports where it WILL open while Chrome is stopped', () => {
    // The question comes before there is anything to look at.
    expect(takeoverHint(status({}), T)).toContain('starts on demand');
  });

  it('says a virtual display cannot be watched as-is', () => {
    expect(takeoverHint(status({ mode: 'virtual', display: ':99', takeover: 'vnc-required' }), T))
      .toContain('VNC needed');
  });

  it('admits headless has no takeover instead of implying one', () => {
    expect(takeoverHint(status({ mode: 'headless', display: null, takeover: 'none' }), T))
      .toContain('no takeover');
  });

  it('omits the parenthetical when there is no display name', () => {
    // macOS/Windows have no DISPLAY; "desktop ()" would read as a bug.
    const line = takeoverHint(status({ display: null }), T);
    expect(line).not.toContain('()');
  });
});

describe('browser startup hint', () => {
  it('covers the foreground wait before the first agent progress', () => {
    expect(browserStartupPending({
      running: true, backgroundRunning: false, device: 'my-pc', turnProgressStarted: false,
    })).toBe(true);
  });

  it('stops after progress and never replaces background status', () => {
    expect(browserStartupPending({
      running: true, backgroundRunning: false, device: 'my-pc', turnProgressStarted: true,
    })).toBe(false);
    expect(browserStartupPending({
      running: true, backgroundRunning: true, device: 'my-pc', turnProgressStarted: false,
    })).toBe(false);
  });

  it('requires browser opt-in and inserts the selected device', () => {
    expect(browserStartupPending({
      running: true, backgroundRunning: false, device: null, turnProgressStarted: false,
    })).toBe(false);
    expect(browserStartupHint('my-pc', 'Starting Chrome on {device}…')).toBe('Starting Chrome on my-pc…');
  });
});
