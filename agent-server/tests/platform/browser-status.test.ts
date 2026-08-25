// input:  the managed browser's status payload
// output: pinned shape of the takeover answer the UI renders
// pos:    tests for the browser status route
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import { browserStatusPayload, BROWSER_STATUS_PATH } from '@platform/ui-http/browser-status.js';

describe('browserStatusPayload', () => {
  it('answers "can I take it over?" even while Chrome is stopped', () => {
    // The user asks before there is anything to look at, so a stopped browser must still report
    // where it WOULD draw rather than an empty answer.
    const payload = browserStatusPayload();
    expect(payload.running).toBe(false);
    expect(payload.cdpEndpoint).toBeNull();
    expect(['attached', 'virtual', 'headless']).toContain(payload.display.mode);
    expect(['remote-desktop', 'vnc-required', 'none']).toContain(payload.display.takeover);
    expect(payload.display.reason.length).toBeGreaterThan(0);
  });

  it('caches the display probe instead of shelling out per request', () => {
    // The probe runs xdpyinfo/launchctl; a polled UI must not spawn processes.
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) browserStatusPayload();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('is served under the api prefix so the same auth gate applies', () => {
    expect(BROWSER_STATUS_PATH.startsWith('/api/')).toBe(true);
  });
});
