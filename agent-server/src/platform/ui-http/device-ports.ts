import type * as http from 'http';
import { createLogger } from '@core/log.js';
import { readJsonBody, sendError, sendJson, sendMethodNotAllowed } from './http-json.js';
import { probeListeners, MIN_FORWARDABLE_PORT, type ListeningPort } from './listening-ports.js';
import type { CustomRouteHandler } from './ui-http-server.js';

const log = createLogger('device-ports');

/** Devices that can currently host a reverse stream. */
export const DEVICES_PATH = '/api/forward/devices';
/** Ports listening on one device's loopback. */
export const DEVICE_PORTS_PATH = '/api/forward/device-ports';
/** Map one of those ports onto a local port here. */
export const DEVICE_PORT_OPEN_PATH = '/api/forward/device-port';
/** Tear a mapping down again once the view that asked for it is gone. */
export const DEVICE_PORT_CLOSE_PATH = '/api/forward/device-port/close';

/** Shape of a mapping as the UI sees it; the domain owns the real type. */
export interface DevicePortMapping {
  device: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
}

/**
 * The remote domain is injected rather than imported: platform may not depend on domain, and the
 * entry layer already owns the job of joining the two.
 */
export interface DevicePortDeps {
  listDevices: () => Array<{ device: string; platform: string }>;
  /** Run a shell command on a device and return its stdout. */
  runOnDevice: (device: string, command: string) => Promise<string>;
  openDevicePort: (device: string, port: number) => Promise<DevicePortMapping>;
  /** False when no such mapping was open. */
  closeDevicePort: (device: string, port: number) => boolean;
  /** Mappings open right now, whoever opened them. */
  listDevicePorts: () => DevicePortMapping[];
}

/**
 * Discover a device's listening ports with whatever its platform actually has — `ss` on Linux,
 * `netstat` on Windows. Getting this wrong is not a degraded answer but an empty one, which reads
 * as "nothing is running there".
 */
async function listRemoteListeners(deps: DevicePortDeps, device: string): Promise<ListeningPort[]> {
  const platform = deps.listDevices().find((d) => d.device === device)?.platform ?? '';
  const { ports, error } = await probeListeners(platform, (command) => deps.runOnDevice(device, command));
  if (error) log.warn(`port discovery on ${device} unavailable: ${error}`);
  return ports;
}

/** `{ device, port }` from a POST body, or null after answering 400/405. */
async function readDevicePort(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<{ device: string; port: number } | null> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST');
    return null;
  }
  const body = await readJsonBody(req, res);
  if (!body) return null;
  const device = typeof body.device === 'string' ? body.device : '';
  const port = Number(body.port);
  if (!device) {
    sendError(res, 400, 'missing-device', 'device is required');
    return null;
  }
  // Same floor as the local forward: nothing a dev server needs lives below 1024, and the
  // accident of mapping 22 is worse than the inconvenience.
  if (!Number.isInteger(port) || port < MIN_FORWARDABLE_PORT || port > 65535) {
    sendError(res, 400, 'bad-port', 'port must be an integer in 1024..65535');
    return null;
  }
  return { device, port };
}

export function createDevicePortRoutes(deps: DevicePortDeps): Record<string, CustomRouteHandler> {
  // A mapping is shared by everyone who asks for the same device port — another window, another
  // device's app, an agent's browser — so a close from one view must not pull it from under the
  // rest. Count the UI's opens of each mapping the UI itself created, and close on the last
  // release. A mapping that already existed when the UI first asked (an agent's) is never closed
  // from here. Miscounts err towards keeping a mapping open, which is the old behaviour anyway:
  // it lives until the device disconnects.
  const uiOpens = new Map<string, number>();
  const keyOf = (device: string, port: number): string => `${device}\u0000${port}`;

  return {
    [DEVICES_PATH]: async (_req, res) => {
      const devices = deps.listDevices().map((d) => ({ device: d.device, platform: d.platform }));
      sendJson(res, 200, { ok: true, data: { devices } });
    },

    [DEVICE_PORTS_PATH]: async (req, res) => {
      const device = new URL(req.url ?? '', 'http://localhost').searchParams.get('device');
      if (!device) return sendError(res, 400, 'missing-device', 'device is required');
      sendJson(res, 200, { ok: true, data: { ports: await listRemoteListeners(deps, device) } });
    },

    [DEVICE_PORT_OPEN_PATH]: async (req, res) => {
      const target = await readDevicePort(req, res);
      if (!target) return;
      const key = keyOf(target.device, target.port);
      const existed = deps.listDevicePorts()
        .some((m) => m.device === target.device && m.remotePort === target.port);
      let mapping: DevicePortMapping;
      try {
        mapping = await deps.openDevicePort(target.device, target.port);
      } catch (err) {
        return sendError(res, 500, 'open-failed', (err as Error).message);
      }
      if (uiOpens.has(key)) uiOpens.set(key, uiOpens.get(key)! + 1);
      else if (!existed) uiOpens.set(key, 1);
      sendJson(res, 200, { ok: true, data: mapping });
    },

    [DEVICE_PORT_CLOSE_PATH]: async (req, res) => {
      const target = await readDevicePort(req, res);
      if (!target) return;
      const key = keyOf(target.device, target.port);
      const opens = uiOpens.get(key) ?? 0;
      if (opens > 1) uiOpens.set(key, opens - 1);
      else uiOpens.delete(key);
      const closed = opens === 1 && deps.closeDevicePort(target.device, target.port);
      sendJson(res, 200, { ok: true, data: { closed } });
    },
  };
}
