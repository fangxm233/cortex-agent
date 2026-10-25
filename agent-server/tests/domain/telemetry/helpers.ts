import { resetSettingsForTests } from '@core/settings.js';
import type { TelemetryEvent } from '@domain/telemetry/schema.js';

export const TEST_ENDPOINT = 'https://telemetry.example.com/v1/batch';

/** Turn the gate on for the duration of a test (dev checkout + explicit opt-in + endpoint). */
export function enableTelemetryForTest(): () => void {
  process.env.CORTEX_TELEMETRY = '1';
  process.env.CORTEX_TELEMETRY_ENDPOINT = TEST_ENDPOINT;
  resetSettingsForTests();
  return () => {
    process.env.CORTEX_TELEMETRY = '0';
    delete process.env.CORTEX_TELEMETRY_ENDPOINT;
    resetSettingsForTests();
  };
}

export function crashEvent(overrides: Partial<Extract<TelemetryEvent, { type: 'crash' }>> = {}): TelemetryEvent {
  return {
    type: 'crash', at: new Date('2026-10-01T00:00:00Z').toISOString(), component: 'server',
    kind: 'uncaughtException', errorName: 'TypeError', message: 'boom', stack: '', groupKey: 'TypeError@x',
    uptimeS: 1, route: null, buildStamp: null, client: null, exit: null, suppressed: 0, ...overrides,
  };
}

export interface CapturedRequest { url: string; body: any }

export function fakeFetch(statuses: number[] = []) {
  const requests: CapturedRequest[] = [];
  const impl = async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    const status = statuses.shift() ?? 200;
    return { ok: status >= 200 && status < 300, status };
  };
  return { impl, requests };
}
