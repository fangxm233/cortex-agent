import assert from 'node:assert/strict';
import { test } from 'vitest';
import { EventBus } from '@events/event-bus.js';
import { createAppRouter } from '@domain/ui-service/app-router.js';
import { createUiService } from '@domain/ui-service/ui-service.js';
import type { UiServiceDeps } from '@domain/ui-service/types.js';
import { setWebReportSink } from '@domain/telemetry/web-report.js';
import { isInstallId } from '@domain/telemetry/install-id.js';
import { resetSettingsForTests } from '@core/settings.js';

async function withTelemetryOn(fn: () => Promise<void>): Promise<void> {
  process.env.CORTEX_TELEMETRY = '1';
  process.env.CORTEX_TELEMETRY_ENDPOINT = 'https://telemetry.example.com/v1/batch';
  resetSettingsForTests();
  try {
    await fn();
  } finally {
    process.env.CORTEX_TELEMETRY = '0';
    delete process.env.CORTEX_TELEMETRY_ENDPOINT;
    resetSettingsForTests();
  }
}

function setup(client: 'desktop' | null = null) {
  const events: Array<Record<string, unknown>> = [];
  const deps = {
    bus: Object.assign(new EventBus(), { publish: (event: Record<string, unknown>) => events.push(event) }),
  } as unknown as UiServiceDeps;
  const caller = createAppRouter(createUiService(deps)).createCaller({ client });
  return { events, caller };
}

test('telemetry.info reports the gate and a stable install id', async () => {
  const { caller } = setup();
  const info = await caller.telemetry.info({});
  assert.equal(info.settingEnabled, false);
  assert.equal(info.active, false);
  assert.equal(info.inactiveReason, 'env');
  assert.ok(isInstallId(info.installId));
  assert.equal((await caller.telemetry.info({})).installId, info.installId);
});

test('telemetry.report validates, acknowledges, audits only the kind and carries the client', async () => {
  const seen: unknown[] = [];
  setWebReportSink((report, client) => seen.push([report.kind, client]));
  await withTelemetryOn(async () => {
    const { caller, events } = setup('desktop');
    const result = await caller.telemetry.report({ kind: 'sse_reconnect', count: 2 });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(seen, [['sse_reconnect', 'desktop']]);
    const audit = events.find((event) => event.type === 'ui.mutate-invoked');
    assert.deepEqual(audit?.args, { kind: 'sse_reconnect' });
    assert.equal(audit?.client, 'desktop');
    await assert.rejects(caller.telemetry.report({ kind: 'sse_reconnect', count: 0 } as never));
  });
  setWebReportSink(null);
});

test('telemetry.report is dropped while telemetry is inactive', async () => {
  const seen: unknown[] = [];
  setWebReportSink((report) => seen.push(report));
  try {
    const { caller } = setup();
    assert.deepEqual(await caller.telemetry.report({ kind: 'sse_reconnect', count: 1 }), { ok: true });
    assert.deepEqual(seen, []);
  } finally {
    setWebReportSink(null);
  }
});
