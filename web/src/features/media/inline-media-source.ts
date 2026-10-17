import type { MediaKind } from './media-kind';

function privateIpv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function privateIpv6(host: string): boolean {
  const first = parseInt(host.split(':')[0] || '0', 16);
  if (host === '::' || host === '::1' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
  const mapped = host.match(/^::ffff:([\da-f]+):([\da-f]+)$/);
  if (!mapped) return false;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return privateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

function blockedHost(host: string): boolean {
  if (host.includes(':')) return privateIpv6(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return privateIpv4(host);
  return !host.includes('.') || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal');
}

export function isAllowedMediaUrl(src: string): boolean {
  try {
    const url = new URL(src);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return url.protocol === 'https:' && !blockedHost(host);
  } catch {
    return false;
  }
}

export function isMediaUrl(src: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(src) || /^(?:https?|data|javascript|blob|file):/i.test(src);
}

export function inlineMediaKind(src: string): MediaKind {
  return /\.(mp4|webm|mov|m4v)$/i.test(src.split(/[?#]/)[0]) ? 'video' : 'image';
}
