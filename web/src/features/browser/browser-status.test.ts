import { describe, expect, it } from 'vitest';
import { browserStartupPending } from './browser-status';
import { en, zh } from '@/i18n';
import { forwardErrorText } from './forward-error';
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
    expect(forwardErrorText(new ForwardError('unavailable'), zh)).toBe('端口转发需要桌面应用。');
    expect(forwardErrorText(new ForwardError('list-ports', 500), en)).toBe('Could not list server ports (500)');
    expect(forwardErrorText(new Error('device offline'), zh)).toBe('device offline');
    expect(forwardErrorText('forward_privileged_port', zh)).toBe('只能转发 1024 及以上的端口');
    expect(forwardErrorText('forward_no_local_port: address in use', en))
      .toBe('No local port is free for the forward (address in use)');
    expect(forwardErrorText('relay closed', zh)).toBe('relay closed');
  });
});
