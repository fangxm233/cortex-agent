import { describe, expect, it } from 'vitest';
import { browserStartupPending } from './browser-status';
import { BROWSER_COPY, forwardErrorText } from './browser-copy';
import { ForwardError } from './forward';

describe('browser startup hint', () => {
  it('covers the foreground wait before the first agent progress', () => {
    expect(browserStartupPending({
      running: true, backgroundRunning: false, device: 'desk', turnProgressStarted: false,
    })).toBe(true);
  });

  it('stops after progress and never replaces background status', () => {
    expect(browserStartupPending({
      running: true, backgroundRunning: false, device: 'desk', turnProgressStarted: true,
    })).toBe(false);
    expect(browserStartupPending({
      running: true, backgroundRunning: true, device: 'desk', turnProgressStarted: false,
    })).toBe(false);
  });

  it('requires browser opt-in', () => {
    expect(browserStartupPending({
      running: true, backgroundRunning: false, device: null, turnProgressStarted: false,
    })).toBe(false);
  });
});

describe('forwardErrorText', () => {
  it('localizes forward failures and passes server wording through', () => {
    expect(forwardErrorText(new ForwardError('unavailable'), BROWSER_COPY.zh)).toBe('端口转发需要桌面应用。');
    expect(forwardErrorText(new ForwardError('list-ports', 500), BROWSER_COPY.en)).toBe('Could not list server ports (500)');
    expect(forwardErrorText(new Error('device offline'), BROWSER_COPY.zh)).toBe('device offline');
  });
});
