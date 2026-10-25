import type { ClientKind } from './client-kind.js';
import { captureCrash } from './crash.js';
import { recordFunnelStep } from './funnel.js';
import { recordEventLoopP99, updateRollup, utcDay } from './rollup.js';
import { bucketIndex, type FEATURE_COUNTERS, type MESSAGE_CHANNELS, type WebTelemetryReport } from './schema.js';
import { setWebReportSink } from './web-report.js';

export type FeatureCounter = (typeof FEATURE_COUNTERS)[number];
type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export function countFeature(name: FeatureCounter, by = 1): void {
  if (by <= 0) return;
  updateRollup((rollup) => { rollup.features[name] = (rollup.features[name] ?? 0) + by; });
}

export function countMessage(channel: MessageChannel): void {
  updateRollup((rollup) => { rollup.messagesByChannel[channel] = (rollup.messagesByChannel[channel] ?? 0) + 1; });
}

/** A chat-platform conduit's channel bucket (`slack:…`, `feishu:…`, `tui-…`). */
export function platformChannel(conduit: string): MessageChannel {
  if (conduit.startsWith('slack')) return 'slack';
  if (conduit.startsWith('feishu')) return 'feishu';
  return conduit.startsWith('tui') ? 'tui' : 'other';
}

export function countUiOp(op: string): void {
  updateRollup((rollup) => { rollup.uiOps[op] = (rollup.uiOps[op] ?? 0) + 1; });
}

const MESSAGE_OPS = new Set(['sessions.send', 'sessions.createAndSend']);
const SESSION_OPS = new Set(['sessions.create', 'sessions.createAndSend']);

/** `ui.mutate-invoked`: the op name, plus a message by app when it sent one. */
export function recordUiMutation(op: string, ok: boolean, client: ClientKind | null | undefined): void {
  countUiOp(op);
  if (!ok) return;
  if (MESSAGE_OPS.has(op)) countMessage(client ?? 'other');
  if (SESSION_OPS.has(op)) {
    countFeature('session_created');
    recordFunnelStep('first_session');
  }
}

/** Agent-side webhook calls that mark a feature in use: `route → action → counter`. */
const WEBHOOK_FEATURES: Record<string, Record<string, FeatureCounter>> = {
  '/webhook/subagent': { start: 'subagent_run' },
  '/webhook/team': { spawn: 'worker_spawned' },
  '/webhook/board': { open: 'board_opened' },
  '/webhook/waitpoint': { create: 'waitpoint_created' },
};

const browserSessions = { day: '', ids: new Set<string>() };

/** A browser counts once per session per day, however often its lease is renewed. */
function countBrowserLease(sessionId: unknown): void {
  const day = utcDay(Date.now());
  if (browserSessions.day !== day) Object.assign(browserSessions, { day, ids: new Set<string>() });
  const key = typeof sessionId === 'string' ? sessionId : '';
  if (browserSessions.ids.has(key)) return;
  browserSessions.ids.add(key);
  countFeature('browser_session');
}

export function recordWebhookCall(url: string | undefined, data: unknown): void {
  const body = (data ?? {}) as { action?: unknown; sessionId?: unknown };
  if (url === '/webhook/browser' && body.action === 'lease') return countBrowserLease(body.sessionId);
  const feature = WEBHOOK_FEATURES[url ?? '']?.[String(body.action)];
  if (!feature) return;
  countFeature(feature);
  if (feature === 'worker_spawned') recordFunnelStep('first_worker');
}

export function recordScheduleCreated(count = 1): void {
  if (count <= 0) return;
  countFeature('schedule_created', count);
  recordFunnelStep('first_schedule');
}

export function recordRemoteClientConnected(): void {
  countFeature('remote_client_connected');
  recordFunnelStep('first_remote_client');
}

export function recordRemoteClientDisconnected(): void {
  updateRollup((rollup) => { rollup.perf.remoteClientDisconnects += 1; });
}

export function recordEventLoopLag(p99Ms: number): void {
  updateRollup((rollup) => recordEventLoopP99(rollup, p99Ms));
}

// ── Boot phases ─────────────────────────────────────────

const bootMarks: Array<[string, number]> = [];

/** Mark the end of a boot phase (time since the previous mark). */
export function markBootPhase(name: string, at = performance.now()): void {
  bootMarks.push([name, at]);
}

/** Record this boot's phase durations in milliseconds; `imports` is module loading. */
export function recordStartup(importsMs: number, totalMs = performance.now()): void {
  const phases: Record<string, number> = { imports: Math.round(importsMs) };
  let previous = importsMs;
  for (const [name, at] of bootMarks) {
    phases[name] = Math.max(0, Math.round(at - previous));
    previous = at;
  }
  phases.total = Math.round(totalMs);
  updateRollup((rollup) => {
    rollup.perf.startups.push(phases);
    if (rollup.perf.startups.length > 10) rollup.perf.startups.shift();
  });
}

// ── Web reports (`telemetry.report`) ────────────────────

function routeTemplate(route: string | null): string | null {
  return route ? route.replace(/[^A-Za-z0-9/:._-]/g, '_').slice(0, 80) : null;
}

function recordWebLoad(report: Extract<WebTelemetryReport, { kind: 'load' }>): void {
  updateRollup(({ perf: { web } }) => {
    web.loads += 1;
    if (report.ttfbMs !== null) web.ttfbMs[bucketIndex('webLoadMs', report.ttfbMs)] += 1;
    if (report.firstRenderMs !== null) web.firstRenderMs[bucketIndex('webLoadMs', report.firstRenderMs)] += 1;
    if (report.interactiveMs !== null) web.interactiveMs[bucketIndex('webLoadMs', report.interactiveMs)] += 1;
  });
}

function recordWebCrash(report: WebTelemetryReport, client: ClientKind | null): void {
  if (report.kind === 'crash') {
    const { crashKind: kind, errorName, message, stack, buildStamp, uptimeS } = report;
    return captureCrash({
      component: 'web', kind, errorName, message, stack, buildStamp, uptimeS, client, route: routeTemplate(report.route),
    });
  }
  if (report.kind !== 'native_crash') return;
  const at = new Date(report.at);
  captureCrash({
    component: report.component, kind: 'panic', errorName: 'panic', message: report.message, stack: report.stack,
    buildStamp: report.appVersion, client, at: Number.isNaN(at.getTime()) ? new Date() : at,
  });
}

function onWebReport(report: WebTelemetryReport, client: ClientKind | null): void {
  if (report.kind === 'load') return recordWebLoad(report);
  if (report.kind === 'sse_reconnect') {
    return updateRollup((rollup) => { rollup.perf.sseReconnects += report.count; });
  }
  recordWebCrash(report, client);
}

export function installWebReportSink(): void {
  setWebReportSink(onWebReport);
}
