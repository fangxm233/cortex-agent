import * as path from 'node:path';
import { PI_AGENT_DIR } from '../../agent-adapter/pi/defaults.js';
import { getInstallId } from '../telemetry/install-id.js';

/** Separate from the telemetry install id, so a provider never sees an id telemetry also reports. */
export const PI_DEVICE_ID_FILE = path.join(PI_AGENT_DIR, 'device-id');

/** Stable installation ID that PI login flows send to providers (e.g. OpenAI's agent host ID). */
export function getPiDeviceId(file: string = PI_DEVICE_ID_FILE): string {
  return getInstallId(file);
}
