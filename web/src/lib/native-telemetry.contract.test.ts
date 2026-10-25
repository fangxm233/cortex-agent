// The desktop shell builds two telemetry payloads by hand in Rust: the setup funnel batch it posts
// straight to the ingest Worker, and the panic record the web UI forwards as `native_crash`. The
// Rust tests pin both to a fixture; this test holds that fixture to the zod schema the server and
// the Worker validate with, so the two sides cannot drift apart.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_SETUP_STEPS, SETUP_FAILURE_CLASSES, TelemetryBatchSchema, WebTelemetryReportSchema,
} from '../../../agent-server/src/domain/telemetry/schema';

const REPO = path.resolve(import.meta.dirname, '../../..');
const FIXTURE = path.join(REPO, 'desktop/src-tauri/src/setup/telemetry_fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { batches: unknown[]; nativeCrash: object };

describe('native telemetry payloads', () => {
  it('the setup funnel batches are valid batches', () => {
    for (const batch of fixture.batches) expect(TelemetryBatchSchema.safeParse(batch).error).toBeUndefined();
  });

  it('send only desktop setup steps and failure classes', () => {
    const rust = readFileSync(path.join(REPO, 'desktop/src-tauri/src/setup/telemetry.rs'), 'utf8');
    const steps = [...rust.matchAll(/=> "([a-z_]+)",/g)].map((m) => m[1]);
    expect(steps).toEqual(expect.arrayContaining([...DESKTOP_SETUP_STEPS]));
    const table = /const FAILURE_CLASSES[^=]*= &\[([\s\S]*?)\n\];/.exec(rust)?.[1] ?? '';
    const classes = [...table.matchAll(/\("([a-z]+)", &\[/g)].map((m) => m[1]);
    expect(classes.length).toBeGreaterThan(0);
    for (const value of [...classes, 'other']) expect(SETUP_FAILURE_CLASSES).toContain(value);
  });

  it('the panic record forwards as a native crash report', () => {
    const report = { kind: 'native_crash', component: 'desktop', ...fixture.nativeCrash };
    expect(WebTelemetryReportSchema.safeParse(report).error).toBeUndefined();
  });
});
