// input:  a device name, and that device's shell
// output: a CDP endpoint on THIS server that drives a managed Chrome on that device
// pos:    Device browser — the remote twin of platform/browser/managed-browser.ts
// >>> If I am updated, update CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { sendCommand, getOnlineDevices } from './client-manager.js';
import { closeDevicePort, openDevicePort } from './device-port.js';
import { chromeLaunchCommand, chromeStopCommand } from './device-chrome-commands.js';

const log = createLogger('device-browser');

/**
 * One Chrome per device, exactly as `managed-browser.ts` keeps one per server — and for the same
 * reason: a shared instance is what lets a human log in once and have every later turn inherit the
 * session. Per-turn private browsers would mean logging in again every time.
 *
 * The difference from the server-local twin is that nothing here runs in this process. Chrome is
 * launched by the device's own shell, and its debugging port is reachable only because the reverse
 * channel maps it onto a loopback port here.
 */

/** Chrome's own startup, plus the device round trip. Generous: a cold Chrome on a busy laptop is
 *  slow, and the alternative to waiting is a turn with no browser tools. */
const LAUNCH_TIMEOUT_MS = 90_000;

/** One HTTP GET through the tunnel. If this is slow, the tunnel is broken, not the browser. */
const VERIFY_TIMEOUT_MS = 5_000;

/** Idle browsers are reclaimed, matching the server-local policy. A window left open on someone's
 *  personal desktop is more intrusive than one on a server, so this is if anything overdue. */
const IDLE_RECLAIM_MS = 10 * 60_000;

export interface DeviceBrowser {
  device: string;
  /** Port Chrome chose on the device. */
  remotePort: number;
  /** Endpoint on THIS server. Everything downstream treats it as an ordinary local CDP endpoint. */
  cdpEndpoint: string;
}

interface Entry extends DeviceBrowser {
  refs: number;
  idleTimer: NodeJS.Timeout | null;
}

const browsers = new Map<string, Entry>();

async function runOnDevice(device: string, command: string, timeout: number): Promise<string> {
  const result = await sendCommand(device, { action: 'bash', params: { command }, timeout });
  if (result?.exitCode !== undefined && result.exitCode !== 0) {
    const detail = String(result.stderr ?? '').trim() || `exit ${result.exitCode}`;
    throw new Error(detail);
  }
  return typeof result?.stdout === 'string' ? result.stdout : '';
}

/**
 * The port is the last all-digits line. Not the whole output: a login shell prints motd, and
 * git-bash emitted a screen-clear escape during testing — neither is an error worth failing on.
 */
export function parseChromePort(stdout: string): number | null {
  const digits = stdout.split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
  if (digits.length === 0) return null;
  const port = Number(digits[digits.length - 1]);
  return port > 0 && port <= 65535 ? port : null;
}

function devicePlatform(device: string): string {
  return getOnlineDevices().find((d) => d.device === device)?.platform ?? '';
}

/** Is the mapped endpoint actually a live Chrome? This is the one check that spans the whole chain:
 *  tunnel, reverse stream, device TCP, and the browser itself. */
async function verifyEndpoint(cdpEndpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${cdpEndpoint}/json/version`, {
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function launchAndMap(device: string, platform: string): Promise<Entry> {
  const stdout = await runOnDevice(device, chromeLaunchCommand(platform), LAUNCH_TIMEOUT_MS);
  const remotePort = parseChromePort(stdout);
  if (remotePort === null) throw new Error(`device ${device} reported no debugging port`);
  const mapping = await openDevicePort(device, remotePort);
  return {
    device,
    remotePort,
    cdpEndpoint: `http://127.0.0.1:${mapping.localPort}`,
    refs: 0,
    idleTimer: null,
  };
}

/**
 * Acquire the device's browser, launching it if needed. Every caller MUST pair this with
 * `releaseDeviceBrowser` in a finally block.
 *
 * The endpoint is verified on every acquire, not only on the first. The device may have rebooted,
 * the human may have quit Chrome, or the port file may name a port nothing is listening on any more
 * — all of which look identical from here, and all of which are fixed the same way: forget the port
 * file and launch again.
 */
export async function acquireDeviceBrowser(device: string): Promise<DeviceBrowser> {
  const platform = devicePlatform(device);
  const existing = browsers.get(device);
  if (existing) {
    if (existing.idleTimer) { clearTimeout(existing.idleTimer); existing.idleTimer = null; }
    if (await verifyEndpoint(existing.cdpEndpoint)) {
      existing.refs++;
      return { device, remotePort: existing.remotePort, cdpEndpoint: existing.cdpEndpoint };
    }
    log.info(`${device}: mapped browser no longer answers — relaunching`);
    closeDevicePort(device, existing.remotePort);
    browsers.delete(device);
  }

  let entry = await launchAndMap(device, platform);
  if (!await verifyEndpoint(entry.cdpEndpoint)) {
    // A dead listener may leave Chrome holding the private profile. Removing only its port file
    // makes the next launch adopt that orphan, so stop the profile-owned process before one retry.
    log.info(`${device}: adopted debugging port ${entry.remotePort} is dead — stopping and relaunching`);
    closeDevicePort(device, entry.remotePort);
    await runOnDevice(device, chromeStopCommand(platform), 30_000);
    entry = await launchAndMap(device, platform);
    if (!await verifyEndpoint(entry.cdpEndpoint)) {
      closeDevicePort(device, entry.remotePort);
      throw new Error(`device ${device} launched Chrome but its debugging port is unreachable`);
    }
  }

  entry.refs = 1;
  browsers.set(device, entry);
  log.info(`${device}: browser on device port ${entry.remotePort} → ${entry.cdpEndpoint}`);
  return { device, remotePort: entry.remotePort, cdpEndpoint: entry.cdpEndpoint };
}

function scheduleReclaim(entry: Entry): void {
  entry.idleTimer = setTimeout(() => {
    if (entry.refs > 0) return;
    log.info(`${entry.device}: no browser sessions left — reclaiming Chrome`);
    void stopDeviceBrowser(entry.device).catch((e) =>
      log.warn(`${entry.device}: could not stop Chrome: ${(e as Error).message}`));
  }, IDLE_RECLAIM_MS);
  entry.idleTimer.unref?.();
}

export function releaseDeviceBrowser(device: string): void {
  const entry = browsers.get(device);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0 && !entry.idleTimer) scheduleReclaim(entry);
}

/** Stop the device's Chrome and drop its port mapping. Safe to call for a device that has neither. */
export async function stopDeviceBrowser(device: string): Promise<void> {
  const entry = browsers.get(device);
  if (entry?.idleTimer) clearTimeout(entry.idleTimer);
  browsers.delete(device);
  if (entry) closeDevicePort(device, entry.remotePort);
  await runOnDevice(device, chromeStopCommand(devicePlatform(device)), 30_000);
}

export function deviceBrowserStatus(): Array<Omit<Entry, 'idleTimer'>> {
  return [...browsers.values()].map(({ idleTimer: _idleTimer, ...rest }) => ({ ...rest }));
}

/**
 * Forget every device browser without touching the devices.
 *
 * Called on daemon shutdown: a Chrome on someone else's machine is not ours to kill on our way out,
 * and the next acquire re-verifies anyway, so leaving it running costs nothing but a window.
 */
export function forgetDeviceBrowsers(): void {
  for (const entry of browsers.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
  }
  browsers.clear();
}
