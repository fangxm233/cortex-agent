import { telemetryInfo, type TelemetryInfo } from '@domain/telemetry/info.js';
import type { QueryParams, UiServiceDeps } from '../types.js';

export async function handleTelemetryInfo(
  _deps: UiServiceDeps,
  _params: QueryParams<'telemetry.info'>,
): Promise<TelemetryInfo> {
  return telemetryInfo();
}
