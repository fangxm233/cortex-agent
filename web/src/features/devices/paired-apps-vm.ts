import { fmt, type Vocab } from '@/i18n';
import { dayLabel, timeAgo, type TimeLang } from '@/i18n/time-format';
import { pairingLink } from '@/lib/pairing';
import type { MintedPairingCode, PairedDevice } from './devices-api';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface PairedAppRow {
  id: string;
  name: string;
  meta: string;
  current: boolean;
}

export interface ActiveCodeView {
  code: string;
  expires: string;
  hint: string;
  /** Address + code in one link; null when this UI is reached on a loopback address. */
  link: string | null;
}

/** The address a new device can use, or null when this UI is only reachable on this machine. */
export function pairingAddress(serverUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** `m:ss` left until `expiresAt`. */
export function pairingCountdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function activeCodeView(code: MintedPairingCode, now: number, address: string | null, L: Vocab): ActiveCodeView {
  return {
    code: code.code,
    expires: fmt(L.pairExpiresIn, { time: pairingCountdown(code.expiresAt, now) }),
    hint: address ? fmt(L.pairHintWithAddress, { address }) : L.pairHint,
    link: address ? pairingLink(address, code.code) : null,
  };
}

export function pairedAppRows(devices: PairedDevice[], now: number, lang: TimeLang, L: Vocab): PairedAppRow[] {
  return devices.map((device) => ({
    id: device.id,
    name: device.name,
    current: device.current,
    meta: `${fmt(L.pairPaired, { date: dayLabel(device.createdAt, new Date(now), lang) })} · `
      + fmt(L.pairLastUsed, { ago: timeAgo(device.lastSeenAt, now, lang) }),
  }));
}
