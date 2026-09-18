import { describe, expect, it } from 'vitest';
import { browserStartupPending } from './browser-status';

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

  it('requires browser opt-in', () => {
    expect(browserStartupPending({
      running: true, backgroundRunning: false, device: null, turnProgressStarted: false,
    })).toBe(false);
  });
});
