// input:  device-port route handlers driven with fake requests and injected device operations
// output: pinned validation and response shape for mapping a port on another machine
// pos:    tests for the device-facing port routes
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type * as http from 'http';
import {
  createDevicePortRoutes, DEVICE_PORT_OPEN_PATH, DEVICE_PORTS_PATH, DEVICES_PATH,
  type DevicePortDeps,
} from '@platform/ui-http/device-ports.js';

const listDevices = vi.fn(() => [] as Array<{ device: string; platform: string }>);
const runOnDevice = vi.fn(async (_d: string, _c: string) => '');
const openDevicePort = vi.fn();
const deps = {
  listDevices, runOnDevice, openDevicePort, listDevicePorts: () => [],
} as unknown as DevicePortDeps;
const routes = createDevicePortRoutes(deps);

interface Captured { status: number; body: any }

function fakeRes(): { res: http.ServerResponse; out: Captured } {
  const out: Captured = { status: 0, body: null };
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(chunk?: string) { out.body = chunk ? JSON.parse(chunk) : null; },
  } as unknown as http.ServerResponse;
  return { res, out };
}

function fakeReq(method: string, url: string, body?: unknown): http.IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { method, url, headers: {} }) as unknown as http.IncomingMessage;
}

beforeEach(() => {
  listDevices.mockReset().mockReturnValue([]);
  runOnDevice.mockReset().mockResolvedValue('');
  openDevicePort.mockReset();
});

describe('device port routes', () => {
  it('are served under the api prefix so the same auth gate applies', () => {
    for (const p of [DEVICES_PATH, DEVICE_PORTS_PATH, DEVICE_PORT_OPEN_PATH]) {
      expect(p.startsWith('/api/')).toBe(true);
    }
  });

  it('lists online devices without their transport details', async () => {
    listDevices.mockReturnValue([
      { device: 'my-pc', platform: 'win32', capabilities: ['bash'], ws: {} } as any,
    ]);
    const { res, out } = fakeRes();
    await routes[DEVICES_PATH](fakeReq('GET', DEVICES_PATH), res);
    expect(out.body.data.devices).toEqual([{ device: 'my-pc', platform: 'win32' }]);
  });

  it('refuses a port listing without a device', async () => {
    const { res, out } = fakeRes();
    await routes[DEVICE_PORTS_PATH](fakeReq('GET', DEVICE_PORTS_PATH), res);
    expect(out.status).toBe(400);
    expect(runOnDevice).not.toHaveBeenCalled();
  });

  it('parses ss output from the device', async () => {
    runOnDevice.mockResolvedValue('LISTEN 0 511 127.0.0.1:6006 0.0.0.0:* users:(("python",pid=9,fd=3))\n');
    const { res, out } = fakeRes();
    await routes[DEVICE_PORTS_PATH](fakeReq('GET', `${DEVICE_PORTS_PATH}?device=my-pc`), res);
    expect(out.body.data.ports).toEqual([{ port: 6006, address: '127.0.0.1', process: 'python' }]);
  });

  it('falls back to unprivileged ss when the first form returns nothing', async () => {
    runOnDevice
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('LISTEN 0 4096 *:3005 *:*\n');
    const { res, out } = fakeRes();
    await routes[DEVICE_PORTS_PATH](fakeReq('GET', `${DEVICE_PORTS_PATH}?device=my-pc`), res);
    expect(out.body.data.ports).toEqual([{ port: 3005, address: '*', process: null }]);
  });

  it('reports an empty list when the device cannot answer', async () => {
    // A device without `ss` (every Windows box) is a normal setup, not a failure to show the user.
    runOnDevice.mockRejectedValue(new Error('Device "my-pc" is not online'));
    const { res, out } = fakeRes();
    await routes[DEVICE_PORTS_PATH](fakeReq('GET', `${DEVICE_PORTS_PATH}?device=my-pc`), res);
    expect(out.status).toBe(200);
    expect(out.body.data.ports).toEqual([]);
  });

  it('maps a device port and returns the local one', async () => {
    openDevicePort.mockResolvedValue({ device: 'my-pc', remoteHost: '127.0.0.1', remotePort: 6006, localPort: 41234 });
    const { res, out } = fakeRes();
    await routes[DEVICE_PORT_OPEN_PATH](fakeReq('POST', DEVICE_PORT_OPEN_PATH, { device: 'my-pc', port: 6006 }), res);
    expect(out.status).toBe(200);
    expect(out.body.data.localPort).toBe(41234);
    expect(openDevicePort).toHaveBeenCalledWith('my-pc', 6006);
  });

  it('refuses privileged and malformed ports', async () => {
    // Same floor as the local forward — mapping 22 by accident is worse than the inconvenience.
    for (const port of [22, 0, 70000, 'x']) {
      const { res, out } = fakeRes();
      await routes[DEVICE_PORT_OPEN_PATH](fakeReq('POST', DEVICE_PORT_OPEN_PATH, { device: 'my-pc', port }), res);
      expect(out.status).toBe(400);
    }
    expect(openDevicePort).not.toHaveBeenCalled();
  });

  it('surfaces an open failure rather than pretending it worked', async () => {
    openDevicePort.mockRejectedValue(new Error('too many device ports open (32)'));
    const { res, out } = fakeRes();
    await routes[DEVICE_PORT_OPEN_PATH](fakeReq('POST', DEVICE_PORT_OPEN_PATH, { device: 'my-pc', port: 6006 }), res);
    expect(out.status).toBe(500);
    expect(out.body.error).toContain('too many');
  });
});
