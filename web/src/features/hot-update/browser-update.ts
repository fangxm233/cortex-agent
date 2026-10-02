import type { ChannelOutcome } from '@/lib/native-bridge';

export interface BrowserPageUpdate { kind: 'browser-page' }
const CHECK_TIMEOUT_MS = 10_000;

function entryAssets(doc: Document, selector: string, attr: string, url: URL, extension: string): string[] {
  return Array.from(doc.querySelectorAll(selector)).flatMap((node) => {
    try {
      const asset = new URL(node.getAttribute(attr) ?? '', url);
      const hashed = new RegExp(`/assets/[^/]+-[A-Za-z0-9_-]{8,}\\.${extension}$`);
      if (asset.origin !== url.origin || !hashed.test(asset.pathname)) return [];
      return [asset.href];
    } catch { return []; }
  }).sort();
}

/** Only production Cortex entry tags count, not lazy chunks or mutable theme/font styles. */
export function readBrowserEntry(doc: Document, href: string): string | null {
  const url = new URL(href);
  if (!/^https?:$/.test(url.protocol) || doc.title !== 'Cortex' || !doc.querySelector('#root')) return null;
  if (doc.querySelector('base, script[src*="/@vite/client"], script[src*="/src/"]')) return null;
  const modules = entryAssets(doc, 'script[type="module"][src]', 'src', url, 'js');
  const styles = entryAssets(doc, 'link[rel="stylesheet"][href]', 'href', url, 'css');
  if (!modules.length || !styles.length) return null;
  return JSON.stringify([modules, styles]);
}

async function fetchEntry(href: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(href, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal });
  const html = response.headers.get('content-type')?.split(';')[0].trim();
  if (!response.ok || response.redirected || response.url !== href || html !== 'text/html') {
    throw new Error('invalid_page');
  }
  const text = await response.text();
  const entry = readBrowserEntry(new DOMParser().parseFromString(text, 'text/html'), href);
  if (!entry) throw new Error('invalid_entry');
  return entry;
}

/** Always compare against this loaded document. A check must never advance its baseline. */
export async function checkBrowserUpdate(): Promise<ChannelOutcome<BrowserPageUpdate>> {
  if (typeof document === 'undefined') return { status: 'skipped', reason: 'unsupported_page' };
  const url = new URL(location.href);
  url.hash = '';
  const loaded = readBrowserEntry(document, url.href);
  if (!loaded) return { status: 'skipped', reason: 'unsupported_page' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const fresh = await fetchEntry(url.href, controller.signal);
    return fresh === loaded ? { status: 'current' } : { status: 'available', update: { kind: 'browser-page' } };
  } catch {
    return { status: 'error', reason: 'check_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

/** Called only by the refresh confirmation, never by discovery or reconnection. */
export function reloadBrowserPage(): void { location.reload(); }
