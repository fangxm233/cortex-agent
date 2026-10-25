// Pairing and paired-device routes.
//
//   POST /api/ui/pair            PUBLIC  {code, name} → {token}: an app trades a pairing code for its
//                                        own device token.
//   POST /api/ui/pairing-code    gated   → {code, expiresAt}: a signed-in UI mints a code.
//   GET  /api/ui/devices         gated   → {devices, pairing}: paired apps, `current` marking the caller.
//   POST /api/ui/devices/revoke  gated   {id}: the device's token stops working at once.
//
// Pairing (the first two) exists only while browser token login is on; with it off the server has
// no public door at all, and the list only offers revoking what was paired before.

import type * as http from 'http';
import { AUTH_HEADER } from '@core/auth.js';
import { createLogger } from '@core/log.js';
import { readJsonBody, sendError, sendJson, sendMethodNotAllowed } from './http-json.js';
import type { CustomRouteHandler } from './ui-http-server.js';
import { LOGIN_FAILURE_DELAY_MS } from './ui-auth-routes.js';
import type { UiDeviceStore } from './ui-devices.js';
import type { PairingStore } from './ui-pairing.js';

const log = createLogger('ui-http');

export const UI_PAIR_PATH = '/api/ui/pair';
export const UI_PAIRING_CODE_PATH = '/api/ui/pairing-code';
export const UI_DEVICES_PATH = '/api/ui/devices';
export const UI_DEVICE_REVOKE_PATH = '/api/ui/devices/revoke';

export interface UiDeviceRouteDeps {
  devices: UiDeviceStore;
  /** Absent when token login is off. */
  pairing?: PairingStore;
}

function presentedToken(req: http.IncomingMessage): string | undefined {
  const v = req.headers[AUTH_HEADER];
  return Array.isArray(v) ? v[0] : v;
}

function pairRoute(devices: UiDeviceStore, pairing: PairingStore): CustomRouteHandler {
  return async (req, res) => {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
    const body = await readJsonBody(req, res);
    if (!body) return;
    const code = typeof body.code === 'string' ? body.code : '';
    if (!pairing.redeem(code)) {
      await new Promise((resolve) => setTimeout(resolve, LOGIN_FAILURE_DELAY_MS));
      log.warn('app pairing rejected: wrong or expired code');
      return sendError(res, 401, 'invalid-code', 'Invalid or expired pairing code');
    }
    const { device, token } = devices.issue(typeof body.name === 'string' ? body.name : '');
    log.info(`app paired: ${device.name} (${device.id})`);
    sendJson(res, 200, { ok: true, data: { token, device } });
  };
}

function pairingCodeRoute(pairing: PairingStore): CustomRouteHandler {
  return async (req, res) => {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
    sendJson(res, 200, { ok: true, data: pairing.create() }, { 'Cache-Control': 'no-store' });
  };
}

function listRoute(deps: UiDeviceRouteDeps): CustomRouteHandler {
  return async (req, res) => {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
    const current = deps.devices.match(presentedToken(req))?.id;
    const devices = deps.devices.list().map((d) => ({ ...d, current: d.id === current }));
    sendJson(res, 200, { ok: true, data: { devices, pairing: !!deps.pairing } }, { 'Cache-Control': 'no-store' });
  };
}

function revokeRoute(devices: UiDeviceStore): CustomRouteHandler {
  return async (req, res) => {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
    const body = await readJsonBody(req, res);
    if (!body) return;
    const id = typeof body.id === 'string' ? body.id : '';
    if (!devices.revoke(id)) return sendError(res, 404, 'not-found', 'No such device');
    log.info(`paired app revoked: ${id}`);
    sendJson(res, 200, { ok: true });
  };
}

export function createUiDeviceRoutes(deps: UiDeviceRouteDeps): Record<string, CustomRouteHandler> {
  const pairingRoutes = deps.pairing
    ? { [UI_PAIR_PATH]: pairRoute(deps.devices, deps.pairing), [UI_PAIRING_CODE_PATH]: pairingCodeRoute(deps.pairing) }
    : {};
  return {
    ...pairingRoutes,
    [UI_DEVICES_PATH]: listRoute(deps),
    [UI_DEVICE_REVOKE_PATH]: revokeRoute(deps.devices),
  };
}
