import type { ClientKind } from './client-kind.js';
import { isTelemetryActive } from './gate.js';
import type { WebTelemetryReport } from './schema.js';

type WebReportSink = (report: WebTelemetryReport, client: ClientKind | null) => void;

let sink: WebReportSink | null = null;

/** The telemetry service installs the real handler once it starts. */
export function setWebReportSink(next: WebReportSink | null): void {
  sink = next;
}

/** Fold one `telemetry.report` observation in; dropped when telemetry is inactive. */
export function recordWebReport(report: WebTelemetryReport, client: ClientKind | null): void {
  if (!sink || !isTelemetryActive()) return;
  try { sink(report, client); } catch { /* telemetry never fails a request */ }
}
