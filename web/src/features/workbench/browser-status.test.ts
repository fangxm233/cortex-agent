// input:  browser status payloads
// output: pinned takeover sentences for each display mode
// pos:    unit tests for browser takeover reporting
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, expect, it } from 'vitest';
import { takeoverHint, type BrowserStatus } from './browser-status';

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
