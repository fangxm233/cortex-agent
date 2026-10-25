// The web UI's outgoing telemetry: raw observations for its own server (`telemetry.report`),
// which redacts them, applies the master switch and folds them into its upload. Mirrors
// `WebTelemetryReportSchema` in agent-server/src/domain/telemetry/schema.ts.

export type WebCrashKind = 'renderError' | 'windowError' | 'unhandledRejection';

export type WebTelemetryReport =
  | {
    kind: 'crash'; crashKind: WebCrashKind; errorName: string; message: string; stack: string;
    route: string | null; buildStamp: string | null; uptimeS: number | null;
  }
  | {
    kind: 'native_crash'; component: 'desktop' | 'android'; at: string; message: string;
    stack: string; appVersion: string;
  }
  | { kind: 'load'; ttfbMs: number | null; firstRenderMs: number | null; interactiveMs: number | null }
  | { kind: 'sse_reconnect'; count: number };

export type ReportSink = (report: WebTelemetryReport) => Promise<unknown>;

/** Reports held while it is not yet known whether this server takes them. */
const MAX_PENDING = 20;
/** Distinct crashes one page load reports; a render loop must not flood its server. */
const MAX_CRASHES = 10;

function crashKey(report: WebTelemetryReport): string | null {
  if (report.kind !== 'crash') return null;
  const firstFrame = report.stack.split('\n').find((line) => /\s+at\s|@/.test(line)) ?? '';
  return [report.crashKind, report.errorName, report.message.slice(0, 200), firstFrame.trim()].join('|');
}

/**
 * Holds reports until the server says whether telemetry is active: `attach` flushes them to the
 * sink; `detach` (off) drops them and everything reported until the next `attach`; `disable` (no
 * server at all) drops everything from then on.
 */
export class ReportQueue {
  private sink: ReportSink | null = null;
  private disabled = false;
  /** Known to be off: nothing is held for a later `attach`. */
  private off = false;
  private pending: WebTelemetryReport[] = [];
  private readonly crashes = new Set<string>();

  enqueue(report: WebTelemetryReport): void {
    if (this.disabled || this.off || !this.admitCrash(report)) return;
    if (this.sink) this.send(this.sink, report);
    else if (this.pending.length < MAX_PENDING) this.pending.push(report);
  }

  attach(sink: ReportSink): void {
    if (this.disabled) return;
    this.off = false;
    this.sink = sink;
    const held = this.pending;
    this.pending = [];
    held.forEach((report) => this.send(sink, report));
  }

  /** Telemetry is off for this server: drop what is held and what comes until it is back on. */
  detach(): void {
    this.off = true;
    this.sink = null;
    this.pending = [];
  }

  disable(): void {
    this.disabled = true;
    this.detach();
  }

  private admitCrash(report: WebTelemetryReport): boolean {
    const key = crashKey(report);
    if (key === null) return true;
    if (this.crashes.has(key) || this.crashes.size >= MAX_CRASHES) return false;
    this.crashes.add(key);
    return true;
  }

  private send(sink: ReportSink, report: WebTelemetryReport): void {
    // Best effort: a failed report is dropped, never retried or surfaced.
    sink(report).catch(() => undefined);
  }
}

/** The page's one queue. */
export const telemetryQueue = new ReportQueue();
