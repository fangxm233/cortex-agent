// input:  a faked device shell and a faked CDP endpoint
// output: pinned acquire/verify/relaunch/reclaim policy for a browser on another machine
// pos:    tests for the remote twin of the managed browser
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendCommand = vi.fn();
const getOnlineDevices = vi.fn(() => [{ device: 'my-pc', platform: 'win32' }]);
const openDevicePort = vi.fn(async (device: string, port: number) => ({
  device, remoteHost: '127.0.0.1', remotePort: port, localPort: port - 10000,
}));
const closeDevicePort = vi.fn(() => true);

vi.mock('@domain/remote/client-manager.js', () => ({
  sendCommand: (...a: unknown[]) => sendCommand(...(a as [])),
  getOnlineDevices: () => getOnlineDevices(),
}));
vi.mock('@domain/remote/device-port.js', () => ({
  openDevicePort: (...a: unknown[]) => openDevicePort(...(a as [never, never])),
  closeDevicePort: (...a: unknown[]) => closeDevicePort(...(a as [])),
}));

const {
  acquireDeviceBrowser, releaseDeviceBrowser, deviceBrowserStatus, forgetDeviceBrowsers,
  parseChromePort, stopDeviceBrowser,
} = await import('@domain/remote/device-browser.js');

/** Ports whose CDP endpoint answers. Everything else fails, standing in for a dead browser. */
let alive = new Set<number>();

function portOf(url: string): number {
  return Number(new URL(url).port);
}

beforeEach(() => {
  alive = new Set<number>();
  sendCommand.mockReset().mockResolvedValue({ stdout: '', exitCode: 0 });
  openDevicePort.mockClear();
  closeDevicePort.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: alive.has(portOf(url)) })));
});

afterEach(() => {
  forgetDeviceBrowsers();
  vi.unstubAllGlobals();
});

/** Device answers a launch with `port`, and that mapped port is (or is not) live. */
function deviceReports(port: number, live: boolean): void {
  sendCommand.mockResolvedValue({ stdout: `${port}\n`, exitCode: 0 });
  if (live) alive.add(port - 10000);
}

describe('parseChromePort', () => {
  it('takes the last all-digits line', () => {
    // A login shell prints a motd, and git-bash emitted a screen-clear escape during testing —
    // neither is an error worth failing the turn on.
    expect(parseChromePort('Last login: today\n54964\n')).toBe(54964);
    expect(parseChromePort('54964\n[H[2J')).toBe(54964);
  });

  it('refuses output that names no port', () => {
    expect(parseChromePort('')).toBeNull();
    expect(parseChromePort('chrome-not-found')).toBeNull();
    expect(parseChromePort('99999')).toBeNull();
  });
});

describe('acquireDeviceBrowser', () => {
  it('launches, maps the port, and hands back a plain local endpoint', async () => {
    deviceReports(54964, true);
    const b = await acquireDeviceBrowser('my-pc');
    // Everything downstream must be unable to tell this from the server's own browser.
    expect(b.cdpEndpoint).toBe('http://127.0.0.1:44964');
    expect(b.remotePort).toBe(54964);
    expect(openDevicePort).toHaveBeenCalledWith('my-pc', 54964);
  });

  it('reuses a live browser without relaunching', async () => {
    deviceReports(54964, true);
    await acquireDeviceBrowser('my-pc');
    const calls = sendCommand.mock.calls.length;
    const b = await acquireDeviceBrowser('my-pc');
    expect(b.cdpEndpoint).toBe('http://127.0.0.1:44964');
    expect(sendCommand.mock.calls.length).toBe(calls); // verified over HTTP, not re-launched
    expect(deviceBrowserStatus()[0].refs).toBe(2);
  });

  it('stops the orphan and relaunches when the adopted port is dead', async () => {
    // A dead CDP listener can leave Chrome holding the private profile. Removing only the port file
    // makes Chrome adopt the orphan instead of starting a fresh listener, so retry must stop it.
    sendCommand
      .mockResolvedValueOnce({ stdout: '49170\n', exitCode: 0 })  // adopted, dead
      .mockResolvedValueOnce({ stdout: '', exitCode: 0 })         // stop orphan and clear port file
      .mockResolvedValueOnce({ stdout: '54964\n', exitCode: 0 }); // relaunched, live
    alive.add(54964 - 10000);
    const b = await acquireDeviceBrowser('my-pc');
    expect(b.remotePort).toBe(54964);
    expect(closeDevicePort).toHaveBeenCalledWith('my-pc', 49170);
    expect(sendCommand.mock.calls[1][1].params.command).toContain('Stop-Process');
    expect(sendCommand.mock.calls[1][1].params.command).toContain('Stop-ScheduledTask');
  });

  it('gives up after one retry rather than looping', async () => {
    deviceReports(54964, false);
    await expect(acquireDeviceBrowser('my-pc')).rejects.toThrow(/unreachable/);
    expect(deviceBrowserStatus()).toEqual([]);
  });

  it('relaunches when a previously mapped browser stops answering', async () => {
    deviceReports(54964, true);
    await acquireDeviceBrowser('my-pc');
    releaseDeviceBrowser('my-pc');
    // The device rebooted, or the human quit Chrome; from here those look identical.
    alive.clear();
    sendCommand.mockReset().mockResolvedValue({ stdout: '55555\n', exitCode: 0 });
    alive.add(55555 - 10000);
    const b = await acquireDeviceBrowser('my-pc');
    expect(b.remotePort).toBe(55555);
    expect(closeDevicePort).toHaveBeenCalledWith('my-pc', 54964);
  });

  it('surfaces a device that has no Chrome', async () => {
    sendCommand.mockResolvedValue({ stdout: '', stderr: 'chrome-not-found', exitCode: 3 });
    await expect(acquireDeviceBrowser('my-pc')).rejects.toThrow('chrome-not-found');
  });
});

describe('release and reclaim', () => {
  it('keeps the browser while any turn still holds it', async () => {
    deviceReports(54964, true);
    await acquireDeviceBrowser('my-pc');
    await acquireDeviceBrowser('my-pc');
    releaseDeviceBrowser('my-pc');
    expect(deviceBrowserStatus()[0].refs).toBe(1);
  });

  it('never drops below zero on an unbalanced release', async () => {
    deviceReports(54964, true);
    await acquireDeviceBrowser('my-pc');
    releaseDeviceBrowser('my-pc');
    releaseDeviceBrowser('my-pc');
    expect(deviceBrowserStatus()[0].refs).toBe(0);
  });

  it('stops Chrome and drops the mapping on an explicit stop', async () => {
    deviceReports(54964, true);
    await acquireDeviceBrowser('my-pc');
    await stopDeviceBrowser('my-pc');
    expect(deviceBrowserStatus()).toEqual([]);
    expect(closeDevicePort).toHaveBeenCalledWith('my-pc', 54964);
    expect(sendCommand.mock.calls.at(-1)?.[1].params.command).toContain('Stop-Process');
  });

  it('forgets browsers on shutdown without killing them', async () => {
    // A Chrome on someone else's machine is not ours to kill on our way out, and the next acquire
    // re-verifies anyway.
    deviceReports(54964, true);
    await acquireDeviceBrowser('my-pc');
    const calls = sendCommand.mock.calls.length;
    forgetDeviceBrowsers();
    expect(deviceBrowserStatus()).toEqual([]);
    expect(sendCommand.mock.calls.length).toBe(calls);
  });
});
