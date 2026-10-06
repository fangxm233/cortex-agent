import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as http from 'http';
import {
  createDevicePortRoutes, DEVICE_PORT_CLOSE_PATH, DEVICE_PORT_OPEN_PATH, DEVICE_PORTS_PATH, DEVICES_PATH,
  type DevicePortDeps,
} from '@platform/ui-http/device-ports.js';
import type { CustomRouteHandler } from '@platform/ui-http/ui-http-server.js';
import { asServerResponse, fakeReq, fakeRes } from '../helpers/http.js';

const listDevices = vi.fn(() => [] as Array<{ device: string; platform: string }>);
const runOnDevice = vi.fn(async (_d: string, _c: string) => '');
const openDevicePort = vi.fn();
const closeDevicePort = vi.fn((_d: string, _p: number) => true);
const listDevicePorts = vi.fn(() => [] as Array<{ device: string; remotePort: number }>);
const deps = { listDevices, runOnDevice, openDevicePort, closeDevicePort, listDevicePorts } as unknown as DevicePortDeps;
let routes = createDevicePortRoutes(deps);

interface Captured { status: number; body: any }

async function send(handler: CustomRouteHandler, req: http.IncomingMessage): Promise<Captured> {
  const res = fakeRes();
  await handler(req, asServerResponse(res));
  return { status: res.statusCode, body: res.text ? res.json() : null };
}

beforeEach(() => {
  listDevices.mockReset().mockReturnValue([]);
  runOnDevice.mockReset().mockResolvedValue('');
  openDevicePort.mockReset();
  closeDevicePort.mockReset().mockReturnValue(true);
  listDevicePorts.mockReset().mockReturnValue([]);
  routes = createDevicePortRoutes(deps);
});

const MAPPING = { device: 'desk', remoteHost: '127.0.0.1', remotePort: 6006, localPort: 41234 };

function call(path: string, port = 6006): Promise<Captured> {
  return send(routes[path], fakeReq('POST', path, { device: 'desk', port }));
}

/** The domain's view after the first open: the mapping now exists. */
function mappingExists(): void {
  listDevicePorts.mockReturnValue([MAPPING]);
}

describe('device port routes', () => {

  it('lists online devices without their transport details', async () => {
    listDevices.mockReturnValue([
      { device: 'desk', platform: 'win32', capabilities: ['bash'], ws: {} } as any,
    ]);
    const out = await send(routes[DEVICES_PATH], fakeReq('GET', DEVICES_PATH));
    expect(out.body.data.devices).toEqual([{ device: 'desk', platform: 'win32' }]);
  });

  it('refuses a port listing without a device', async () => {
    const out = await send(routes[DEVICE_PORTS_PATH], fakeReq('GET', DEVICE_PORTS_PATH));
    expect(out.status).toBe(400);
    expect(runOnDevice).not.toHaveBeenCalled();
  });

  it('parses ss output from the device', async () => {
    runOnDevice.mockResolvedValue('LISTEN 0 511 127.0.0.1:6006 0.0.0.0:* users:(("python",pid=9,fd=3))\n');
    const out = await send(routes[DEVICE_PORTS_PATH], fakeReq('GET', `${DEVICE_PORTS_PATH}?device=desk`));
    expect(out.body.data.ports).toEqual([{ port: 6006, address: '127.0.0.1', process: 'python' }]);
  });

  it('falls back to unprivileged ss when the first form returns nothing', async () => {
    runOnDevice
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('LISTEN 0 4096 *:3005 *:*\n');
    const out = await send(routes[DEVICE_PORTS_PATH], fakeReq('GET', `${DEVICE_PORTS_PATH}?device=desk`));
    expect(out.body.data.ports).toEqual([{ port: 3005, address: '*', process: null }]);
  });

  it('reports an empty list when the device cannot answer', async () => {
    // A device without `ss` (every Windows box) is a normal setup, not a failure to show the user.
    runOnDevice.mockRejectedValue(new Error('Device "desk" is not online'));
    const out = await send(routes[DEVICE_PORTS_PATH], fakeReq('GET', `${DEVICE_PORTS_PATH}?device=desk`));
    expect(out.status).toBe(200);
    expect(out.body.data.ports).toEqual([]);
  });

  it('maps a device port and returns the local one', async () => {
    openDevicePort.mockResolvedValue({ device: 'desk', remoteHost: '127.0.0.1', remotePort: 6006, localPort: 41234 });
    const out = await send(routes[DEVICE_PORT_OPEN_PATH], fakeReq('POST', DEVICE_PORT_OPEN_PATH, { device: 'desk', port: 6006 }));
    expect(out.status).toBe(200);
    expect(out.body.data.localPort).toBe(41234);
    expect(openDevicePort).toHaveBeenCalledWith('desk', 6006);
  });

  it('refuses privileged and malformed ports', async () => {
    // Same floor as the local forward — mapping 22 by accident is worse than the inconvenience.
    for (const port of [22, 0, 70000, 'x']) {
      const out = await send(routes[DEVICE_PORT_OPEN_PATH], fakeReq('POST', DEVICE_PORT_OPEN_PATH, { device: 'desk', port }));
      expect(out.status).toBe(400);
    }
    expect(openDevicePort).not.toHaveBeenCalled();
  });

  it('surfaces an open failure rather than pretending it worked', async () => {
    openDevicePort.mockRejectedValue(new Error('too many device ports open (32)'));
    const out = await send(routes[DEVICE_PORT_OPEN_PATH], fakeReq('POST', DEVICE_PORT_OPEN_PATH, { device: 'desk', port: 6006 }));
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ ok: false, code: 'open-failed' });
    expect(out.body.message).toContain('too many');
  });

  it('tries the next probe when one fails instead of giving up', async () => {
    runOnDevice
      .mockRejectedValueOnce(new Error('ss: command not found'))
      .mockResolvedValueOnce('LISTEN 0 4096 *:3005 *:*\n');
    const out = await send(routes[DEVICE_PORTS_PATH], fakeReq('GET', `${DEVICE_PORTS_PATH}?device=desk`));
    expect(out.body.data.ports).toEqual([{ port: 3005, address: '*', process: null }]);
  });

  it('answers 400, not 500, for a JSON body that is not an object', async () => {
    for (const raw of ['null', '[1]', '7', '{bad']) {
      const out = await send(routes[DEVICE_PORT_OPEN_PATH], fakeReq('POST', DEVICE_PORT_OPEN_PATH, raw));
      expect(out.status).toBe(400);
      expect(out.body.code).toBe('bad-json');
    }
    expect(openDevicePort).not.toHaveBeenCalled();
  });

  it('only opens on POST (there is no listing behind GET)', async () => {
    const out = await send(routes[DEVICE_PORT_OPEN_PATH], fakeReq('GET', DEVICE_PORT_OPEN_PATH));
    expect(out.status).toBe(405);
  });

  it('closes a mapping the UI opened once no view shows it', async () => {
    openDevicePort.mockResolvedValue(MAPPING);
    await call(DEVICE_PORT_OPEN_PATH);
    const out = await call(DEVICE_PORT_CLOSE_PATH);
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual({ closed: true });
    expect(closeDevicePort).toHaveBeenCalledWith('desk', 6006);
  });

  it('keeps a mapping another view (window, device) still uses', async () => {
    openDevicePort.mockResolvedValue(MAPPING);
    await call(DEVICE_PORT_OPEN_PATH);
    mappingExists();
    await call(DEVICE_PORT_OPEN_PATH);
    expect((await call(DEVICE_PORT_CLOSE_PATH)).body.data).toEqual({ closed: false });
    expect(closeDevicePort).not.toHaveBeenCalled();
    expect((await call(DEVICE_PORT_CLOSE_PATH)).body.data).toEqual({ closed: true });
    expect(closeDevicePort).toHaveBeenCalledTimes(1);
  });

  it('never closes a mapping that existed before the UI asked (an agent\'s browser)', async () => {
    mappingExists();
    openDevicePort.mockResolvedValue(MAPPING);
    await call(DEVICE_PORT_OPEN_PATH);
    expect((await call(DEVICE_PORT_CLOSE_PATH)).body.data).toEqual({ closed: false });
    expect(closeDevicePort).not.toHaveBeenCalled();
  });

  it('validates a close like an open', async () => {
    const out = await send(routes[DEVICE_PORT_CLOSE_PATH], fakeReq('POST', DEVICE_PORT_CLOSE_PATH, { device: 'desk', port: 22 }));
    expect(out.status).toBe(400);
    expect(closeDevicePort).not.toHaveBeenCalled();
  });
});
