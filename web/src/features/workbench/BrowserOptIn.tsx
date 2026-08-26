// input:  current browser opt-in and connected devices
// output: browser device options for the composer ＋ menu
// pos:    Managed-browser choice model (device list + labels)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useEffect, useState } from 'react';
import { useVocab } from '@/i18n';
import { listForwardDevices, type ForwardDevice } from '@/features/browser/forward';

/** This host's own Chrome. Any other value names a device, whose Chrome is launched by its
 *  cortex-client and reached through the reverse channel (plan/embedded-browser.md §18). */
export const DEFAULT_BROWSER_DEVICE = 'server';

export interface BrowserDeviceOption {
  /** null is the "off" row. */
  device: string | null;
  label: string;
  sub: string;
}

/**
 * Browser control is opt-in per session because it costs ~24 tools of context that a session which
 * never browses should not carry. It can only be chosen BEFORE the session exists: the tool set is
 * fixed when the agent process spawns.
 *
 * The device matters as much as the switch. A browser on the server draws on the server's display;
 * a browser on your laptop opens a window on the screen in front of you, and inherits the logins
 * already in that profile — which is usually the reason to want one.
 *
 * Devices come and go; the list is read when the menu opens rather than held, so it cannot offer
 * a machine that has since disconnected.
 */
export function useBrowserDeviceOptions(open: boolean): BrowserDeviceOption[] {
  const L = useVocab();
  const [devices, setDevices] = useState<ForwardDevice[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    listForwardDevices().then((d) => { if (alive) setDevices(d); }).catch(() => { if (alive) setDevices([]); });
    return () => { alive = false; };
  }, [open]);

  return [
    { device: null, label: L.wbBrowserOffOption, sub: '' },
    { device: DEFAULT_BROWSER_DEVICE, label: DEFAULT_BROWSER_DEVICE, sub: L.wbBrowserThisHost },
    ...devices.map((d) => ({ device: d.device, label: d.device, sub: d.platform })),
  ];
}
