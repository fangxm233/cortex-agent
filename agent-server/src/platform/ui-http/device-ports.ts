// input:  injected device-registry, device-shell and device-port operations
// output: authenticated routes for discovering and mapping ports that live on other machines
// pos:    Web UI transport host — the device-facing half of port discovery
// >>> If I am updated, update CORTEX.md <<<

import type * as http from 'http';
import { createLogger } from '@core/log.js';
import type { ListeningPort } from './port-forward.js';
import { listenerProbes } from './device-listeners.js';

const log = createLogger('device-ports');

/** Devices that can currently host a reverse stream. */
export const DEVICES_PATH = '/api/forward/devices';
/** Ports listening on one device's loopback. */
export const DEVICE_PORTS_PATH = '/api/forward/device-ports';
/** Map one of those ports onto a local port here. */
export const DEVICE_PORT_OPEN_PATH = '/api/forward/device-port';

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
  listDevicePorts: () => DevicePortMapping[];
}

/**
 * Discover a device's listening ports with whatever its platform actually has — `ss` on Linux,
 * `netstat` on Windows. Getting this wrong is not a degraded answer but an empty one, which reads
 * as "nothing is running there".
 */
async function listRemoteListeners(deps: DevicePortDeps, device: string): Promise<ListeningPort[]> {
  const platform = deps.listDevices().find((d) => d.device === device)?.platform ?? '';
  for (const probe of listenerProbes(platform)) {
    try {
      const stdout = await deps.runOnDevice(device, probe.command);
      if (stdout.trim() !== '') return probe.parse(stdout);
    } catch (err) {
      log.warn(`port discovery on ${device} failed: ${(err as Error).message}`);
      return [];
    }
  }
  return [];
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A request body here is two small fields; anything larger is not ours.
    if (size > 8192) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export function createDevicePortRoutes(deps: DevicePortDeps): Record<
  string,
  (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
> {
  return {
    [DEVICES_PATH]: async (_req, res) => {
      const devices = deps.listDevices().map((d) => ({ device: d.device, platform: d.platform }));
      json(res, 200, { ok: true, data: { devices } });
    },

    [DEVICE_PORTS_PATH]: async (req, res) => {
      const device = new URL(req.url ?? '', 'http://localhost').searchParams.get('device');
      if (!device) return json(res, 400, { ok: false, error: 'device is required' });
      const ports = await listRemoteListeners(deps, device);
      json(res, 200, { ok: true, data: { ports } });
    },

    [DEVICE_PORT_OPEN_PATH]: async (req, res) => {
      if (req.method === 'GET') {
        return json(res, 200, { ok: true, data: { ports: deps.listDevicePorts() } });
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST or GET' });
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, 400, { ok: false, error: (err as Error).message });
      }
      const device = typeof body.device === 'string' ? body.device : '';
      const port = Number(body.port);
      if (!device) return json(res, 400, { ok: false, error: 'device is required' });
      // Same floor as the local forward: nothing a dev server needs lives below 1024, and the
      // accident of mapping 22 is worse than the inconvenience.
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return json(res, 400, { ok: false, error: 'port must be an integer in 1024..65535' });
      }
      try {
        json(res, 200, { ok: true, data: await deps.openDevicePort(device, port) });
      } catch (err) {
        json(res, 500, { ok: false, error: (err as Error).message });
      }
    },
  };
}
