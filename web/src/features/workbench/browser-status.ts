// input:  the server's browser status payload
// output: a fetcher plus the human sentence that answers "how do I log in?"
// pos:    Client half of browser takeover reporting
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { apiBase, authHeaders } from '@/lib/desktop-config';

export interface BrowserStatus {
  running: boolean;
  refs: number;
  display: {
    mode: 'attached' | 'virtual' | 'headless';
    display: string | null;
    takeover: 'remote-desktop' | 'vnc-required' | 'none';
    reason: string;
  };
  cdpEndpoint: string | null;
}

export async function fetchBrowserStatus(): Promise<BrowserStatus> {
  const res = await fetch(`${apiBase()}/api/browser/status`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`browser status failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.ok) throw new Error(body?.error ?? 'browser status failed');
  return body.data as BrowserStatus;
}

/**
 * The sentence a user needs when the agent is stuck at a login wall. Logging in is a HUMAN act —
 * the agent inherits the session afterwards — so the UI has to say where that browser physically
 * is, not merely that browsing is enabled.
 */
export function takeoverHint(status: BrowserStatus, t: {
  attached: string; virtual: string; headless: string; running: string; stopped: string;
}): string {
  const where = status.display.display ? ` (${status.display.display})` : '';
  const state = status.running ? t.running : t.stopped;
  switch (status.display.takeover) {
    case 'remote-desktop':
      return `${state} · ${t.attached.replace('{where}', where)}`;
    case 'vnc-required':
      return `${state} · ${t.virtual}`;
    default:
      return `${state} · ${t.headless}`;
  }
}
