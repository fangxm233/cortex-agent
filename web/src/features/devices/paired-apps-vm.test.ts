import { describe, expect, it } from 'vitest';
import { en } from '@/i18n';
import { activeCodeView, pairedAppRows, pairingAddress, pairingCountdown } from './paired-apps-vm';

describe('pairingAddress', () => {
  it('offers a reachable address and hides loopback ones', () => {
    expect(pairingAddress('https://app.example.com/')).toBe('https://app.example.com');
    expect(pairingAddress('http://127.0.0.1:3004')).toBeNull();
    expect(pairingAddress('http://localhost:5173')).toBeNull();
    expect(pairingAddress('http://[::1]:3004')).toBeNull();
    expect(pairingAddress('')).toBeNull();
  });
});

describe('pairingCountdown', () => {
  it('counts down in minutes and seconds, never below zero', () => {
    expect(pairingCountdown(600_000, 0)).toBe('10:00');
    expect(pairingCountdown(61_500, 0)).toBe('1:02');
    expect(pairingCountdown(0, 5_000)).toBe('0:00');
  });
});

describe('activeCodeView', () => {
  it('builds the hint and link from the address', () => {
    const view = activeCodeView({ code: 'ABCD-EFGH', expiresAt: 600_000 }, 0, 'https://h', en);
    expect(view.expires).toBe('expires in 10:00');
    expect(view.hint).toContain('https://h');
    expect(view.link).toBe('https://h/#pair=ABCD-EFGH');
  });

  it('drops the link when no address can be offered', () => {
    const view = activeCodeView({ code: 'ABCD-EFGH', expiresAt: 600_000 }, 0, null, en);
    expect(view.link).toBeNull();
    expect(view.hint).toBe(en.pairHint);
  });
});

describe('pairedAppRows', () => {
  it('describes when each app paired and was last used', () => {
    const now = Date.parse('2026-10-25T12:00:00');
    const rows = pairedAppRows([
      { id: 'a', name: 'Android', createdAt: now - 3_600_000, lastSeenAt: now - 120_000, current: true },
    ], now, 'en', en);
    expect(rows).toEqual([{ id: 'a', name: 'Android', current: true, meta: 'paired Today · last used 2m ago' }]);
  });
});
